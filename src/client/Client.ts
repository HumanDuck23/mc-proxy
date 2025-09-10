import { Authflow, MinecraftJavaCertificates } from "prismarine-auth"
import { EventEmitter } from "node:events"
import * as crypto from "node:crypto"
import mc from "minecraft-protocol"
import minecraftData from "minecraft-data"
import { consola } from "consola"
import * as net from "node:net"

// @ts-ignore
import yggdrasil from "yggdrasil"

import { FramingDecoder } from "../codec/FramingDecoder.js"
import { FramingEncoder } from "../codec/FramingEncoder.js"
import { makeMinecraftCodecs } from "../codec/makeMinecraftCodecs.js"
import { AesDecoder } from "../codec/AesDecoder.js"
import { AesEncoder } from "../codec/AesEncoder.js"

export type ClientOptions = {
  host: string
  version: { name: string, protocol: number }
  username: string
  port?: number
}

export type AuthSession = {
  token: string
  profile: {
    id: string
    name: string
    skins: Array<any>
    capes: Array<any>
  }
  certificates: MinecraftJavaCertificates
}

/**
 * Client class that can connect to a Minecraft server and handle packets.
 */
export class Client extends EventEmitter {
  private options: ClientOptions
  private client: net.Socket
  private yggdrasilServer = yggdrasil.server({})

  private authFlow: Authflow | null = null
  private session: AuthSession | null = null

  private framingDecoder = new FramingDecoder()
  private framingEncoder = new FramingEncoder()
  private aesDec = new AesDecoder()
  private aesEnc = new AesEncoder()

  private serializer: any | null = null
  private deserializer: any | null = null

  private state: mc.States = mc.states.HANDSHAKING
  private mcData: minecraftData.IndexedData | null = null

  private readonly handlePacket = (packet: any) => this.onPacket(packet)

  constructor(options: ClientOptions) {
    super()
    this.options = options
    this.client = new net.Socket()
    this.authFlow = new Authflow(options.username, undefined)
  }

  connect() {
    // auth then set up server
    consola.start(`Authenticating as ${this.options.username}...`)
    this.authFlow?.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: true })
      .then(result => {
        const { token, profile, certificates } = result
        this.session = { token, profile, certificates }
        consola.success(`Authenticated as ${profile.name} (${profile.id})`)

        const port = this.options.port ?? 25565

        this.client.pipe(this.aesDec).pipe(this.framingDecoder)
        this.framingEncoder.pipe(this.aesEnc).pipe(this.client)

        this.setState(mc.states.HANDSHAKING)

        this.client.on("error", (e) => consola.warn(`socket error: ${e.message}`))
        this.client.on("close", () => this.cleanup())

        this.client.connect(port, this.options.host, () => {
          consola.info(`Connected to ${this.options.host}:${port}`)

          this.serializer!.write({
            name: "set_protocol",
            params: {
              protocolVersion: this.options.version.protocol,
              serverHost: this.options.host,
              serverPort: port,
              nextState: 2,
            },
          })

          this.setState(mc.states.LOGIN)

          this.serializer!.write({
            name: "login_start",
            params: {
              username: this.options.username,
              playerUUID: this.session!.profile.id,
            }
          })
        })
      })
      .catch(e => {
        consola.error(`Authentication failed: ${e.message}`)
      })
  }

  private cleanup() {
    try {
      this.framingDecoder.unpipe(this.deserializer as any)
    } catch {
    }
    try {
      (this.serializer as any)?.unpipe(this.framingEncoder)
    } catch {
    }
    try {
      this.client.unpipe(this.framingDecoder)
    } catch {
    }
    try {
      this.framingEncoder.unpipe(this.client)
    } catch {
    }
    try {
      this.deserializer?.removeListener("data", this.handlePacket)
    } catch {
    }
    this.serializer = null
    this.deserializer = null
  }

  private setState(next: mc.States) {
    if (this.state === next && this.serializer && this.deserializer) return
    consola.debug(`Client switching state to ${next}.`)

    if (this.serializer) {
      try {
        this.serializer.unpipe(this.framingEncoder)
      } catch {
      }
    }
    if (this.deserializer) {
      try {
        this.framingDecoder.unpipe(this.deserializer)
      } catch {
      }
      try {
        this.deserializer.removeListener("data", this.handlePacket)
      } catch {
      }
    }

    const { serializer, deserializer } = makeMinecraftCodecs(next, this.options.version.name, false)
    this.serializer = serializer
    this.deserializer = deserializer
    this.state = next

    this.framingDecoder.pipe(this.deserializer)
    this.serializer.pipe(this.framingEncoder)
    this.deserializer.on("data", this.handlePacket)
  }

  private onPacket(packet: any) {
    if (packet.data.name === "compress" || packet.data.name === "set_compression") {
      const threshold = packet.data.params.threshold
      this.framingEncoder.setThreshold(threshold)
      this.framingDecoder.setThreshold(threshold)
      consola.info(`Set compression threshold to ${threshold}.`)
      return
    }

    console.log(packet)

    switch (this.state) {
      case mc.states.LOGIN: {
        if (packet.data.name === "encryption_begin") {
          this.handleEncryptionBegin(packet)
        } else if (packet.data.name === "success") {
          if (this.mcData === null) {
            this.mcData = minecraftData(this.options.version.name)

            if (!this.mcData) {
              consola.error(`Unsupported Minecraft version: ${this.options.version.name}`)
              this.client.destroy()
              return
            }
          }

          let next: mc.States
          if (this.mcData!.version[">="]("1.20.2")) {
            next = mc.states.CONFIGURATION
            this.serializer!.write({
              name: "login_acknowledged",
              params: {}
            })
          } else {
            next = mc.states.PLAY
          }
          this.setState(next)

          this.emit("login")
        }
        break
      }
    }
  }

  private handleEncryptionBegin(packet: any) {
    if (this.session === null) {
      consola.error("Received encryption request but not authenticated.")
      this.client.destroy()
      return
    }

    crypto.randomBytes(16, (err, sharedSecret) => {
      if (err) {
        consola.error(`Failed to generate shared secret: ${err.message}`)
        this.client.destroy()
        return
      }

      this.yggdrasilServer.join(
        this.session!.token,
        this.session!.profile.id,
        packet.data.params.serverId,
        sharedSecret,
        packet.data.params.publicKey,
        (err: any) => {
          if (err) {
            consola.error(`Join failed: ${err.message}`)
            this.client.destroy()
            return
          }

          this.mcData = minecraftData(this.options.version.name)
          if (!this.mcData) {
            consola.error(`Unsupported Minecraft version: ${this.options.version.name}`)
            this.client.destroy()
            return
          }

          const publicKey = this.mcPubKeyToPem(packet.data.params.publicKey)

          const encryptedSecret = crypto.publicEncrypt({
            key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING
          }, sharedSecret)
          const encryptedVerifyToken = crypto.publicEncrypt({
            key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING
          }, packet.data.params.verifyToken)

          this.serializer!.write({
            name: "encryption_begin",
            params: {
              sharedSecret: encryptedSecret,
              verifyToken: encryptedVerifyToken,
            }
          })

          this.aesDec.enable(sharedSecret)
          this.aesEnc.enable(sharedSecret)
        }
      )
    })
  }

  /**
   * From PrismarineJS client implementation:
   * https://github.com/PrismarineJS/node-minecraft-protocol/blob/bf89f7e86526c54d8c43f555d8f6dfa4948fd2d9/src/client/encrypt.js#L79
   * @param mcPubKeyBuffer
   * @private
   */
  private mcPubKeyToPem(mcPubKeyBuffer: Buffer) {
    let pem = "-----BEGIN PUBLIC KEY-----\n"
    let base64PubKey = mcPubKeyBuffer.toString("base64")
    const maxLineLength = 64
    while (base64PubKey.length > 0) {
      pem += base64PubKey.substring(0, maxLineLength) + "\n"
      base64PubKey = base64PubKey.substring(maxLineLength)
    }
    pem += "-----END PUBLIC KEY-----\n"
    return pem
  }
}