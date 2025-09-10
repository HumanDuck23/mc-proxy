import { generateKeyPairSync, privateDecrypt, randomBytes, constants, timingSafeEqual } from "node:crypto"
import { EventEmitter } from "node:events"
import mc from "minecraft-protocol"
import minecraftData from "minecraft-data"
import { consola } from "consola"
import * as net from "node:net"
import NodeRSA from "node-rsa"
import { v3, v4 } from "uuid"

// @ts-ignore
import yggdrasil from "yggdrasil"

import { makeMinecraftCodecs } from "../codec/makeMinecraftCodecs.js"
import { FramingDecoder } from "../codec/FramingDecoder.js"
import { FramingEncoder } from "../codec/FramingEncoder.js"
import { AesDecoder } from "../codec/AesDecoder.js"
import { AesEncoder } from "../codec/AesEncoder.js"
import { Client } from "../client/Client.js"
import { dashedUUID } from "../utils/dashedUUID.js"

export type ServerOptions = {
  port?: number
  host?: string
  remotePort?: number // default 25566
  remoteHost?: string // default localhost as well

  motd?: string
  maxPlayers?: number
  favicon?: string

  compressionThreshold?: number // default 256
}

export type Profile = {
  username: string
  playerUUID: string
}

const UUID_NAMESPACE = v4()

function makeRsa(privatePem: string) {
  const rsa = new NodeRSA(privatePem, "pkcs1", { encryptionScheme: "pkcs1" })
  rsa.setOptions({ environment: "browser" })
  return rsa
}


/**
 * Wraps a node:net server to handle Minecraft packets
 */
export class Server extends EventEmitter {
  private options: ServerOptions
  private server: net.Server
  private defaultVersion = { name: "1.21.8", protocol: 772 as number }

  private publicKey: Buffer | null = null
  private privateKey: string | null = null

  private yggdrasilServer = yggdrasil.server({})

  constructor(options: ServerOptions = {}) {
    super()
    this.options = options
    this.server = net.createServer((socket) => this.handleConnection(socket))
  }

  start() {
    const port = this.options.port ?? 25565
    const host = this.options.host ?? "127.0.0.1"
    this.server.listen(port, host, () => {
      consola.info(`Server listening on ${host}:${port}...`)
    })

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    })
    this.publicKey = publicKey
    this.privateKey = privateKey
  }

  private handleConnection(socket: net.Socket) {
    consola.debug(`Connection from ${socket.remoteAddress}.`)

    let state: mc.States = mc.states.HANDSHAKING
    let version = { ...this.defaultVersion }

    const framingDecoder = new FramingDecoder()
    const framingEncoder = new FramingEncoder()

    const aesDec = new AesDecoder()
    const aesEnc = new AesEncoder()

    let { serializer, deserializer } = makeMinecraftCodecs(state, version.name, true)

    socket.pipe(aesDec).pipe(framingDecoder)
    framingEncoder.pipe(aesEnc).pipe(socket)

    framingDecoder.pipe(deserializer)
    serializer.pipe(framingEncoder)

    let verifyToken: Buffer | null = null
    let gameProfile: Profile | null = null
    let mcData: minecraftData.IndexedData | null = null
    let remoteClient: Client | null = null

    const cleanup = () => {
      try {
        framingDecoder.unpipe(deserializer)
      } catch {
      }
      try {
        serializer.unpipe(framingEncoder)
      } catch {
      }
      try {
        socket.unpipe(framingDecoder)
      } catch {
      }
      try {
        framingEncoder.unpipe(socket)
      } catch {
      }
      for (const s of [framingDecoder, framingEncoder, serializer, deserializer]) {
        try {
          s.destroy?.()
        } catch {
        }
      }
    }

    const onError = (e: any) => {
      consola.warn(`stream error: ${e?.message ?? e}`)
      socket.destroy()
    }
    for (const s of [socket, framingDecoder, framingEncoder, serializer, deserializer]) {
      s.on("error", onError)
    }
    socket.on("end", () => {
      consola.info(`Client ${socket.remoteAddress} disconnected.`)
      if (remoteClient) {
        remoteClient.disconnect()
      }
      cleanup()
    })
    socket.on("close", cleanup)

    const onPacket = (packet: any) => {
      switch (state) {
        case mc.states.HANDSHAKING: {
          if (packet.data.name === "set_protocol") {
            const versions = minecraftData.postNettyVersionsByProtocolVersion.pc
            const protocolVersion = String(packet.data.params.protocolVersion)

            // @ts-ignore
            const mcVersion = (versions[protocolVersion] ?? [null])[0]

            if (mcVersion) {
              version = { name: mcVersion.minecraftVersion, protocol: Number(protocolVersion) }
              consola.info(`Client version ${version.name} (${version.protocol}).`)
            } else {
              consola.warn(`Unknown protocol ${protocolVersion}, keeping default ${version.name}`)
            }

            mcData = minecraftData(version.name)

            const next = packet.data.params.nextState === 1 ? mc.states.STATUS : mc.states.LOGIN
            setState(next)
          }
          break
        }

        case mc.states.STATUS: {
          if (packet.data.name === "ping_start") {
            const response = {
              version: { name: version.name, protocol: version.protocol },
              players: { max: this.options.maxPlayers ?? 1, online: 0 },
              description: { text: this.options.motd ?? "A Minecraft Server" },
              favicon: this.options.favicon
            }

            if (!this.options.favicon) {
              delete response.favicon
            }

            serializer.write({
              name: "server_info",
              params: { response: JSON.stringify(response) }
            })
          } else if (packet.data.name === "ping") {
            serializer.write({
              name: "ping",
              params: { time: packet.data.params.time }
            })
          }
          break
        }

        case mc.states.LOGIN: {
          if (packet.data.name === "login_start") {
            const username = packet.data.params.username
            let uuid = packet.data.params.playerUUID ?? v3(`OfflinePlayer:${username}`, UUID_NAMESPACE)

            gameProfile = { username, playerUUID: uuid }

            consola.info(`Player "${username}" (${uuid}) is logging in.`)

            verifyToken = randomBytes(4)
            if (this.publicKey && this.privateKey) {
              serializer.write({
                name: "encryption_begin",
                params: {
                  serverId: "",
                  publicKey: this.publicKey,
                  verifyToken,
                  shouldAuthenticate: true
                }
              })
            } else {
              // no encryption is not implemented now
              consola.error("Cannot perform online-mode login without a keypair.")
              socket.destroy()
            }
          } else if (packet.data.name === "encryption_begin") {
            const encSecret = packet.data.params.sharedSecret
            const encToken = packet.data.params.verifyToken

            if (!encSecret || !encToken) {
              consola.error("Invalid encryption_begin packet.")
              socket.destroy()
              return
            }

            if (!this.privateKey) {
              consola.error("Private key is missing.")
              socket.destroy()
              return
            }

            if (!verifyToken) {
              consola.error("Verify token is missing.")
              socket.destroy()
              return
            }

            if (!gameProfile) {
              consola.error("Game profile is missing.")
              socket.destroy()
              return
            }

            if (!mcData) {
              consola.error("Minecraft data is missing.")
              socket.destroy()
              return
            }

            const rsa = makeRsa(this.privateKey!)

            const sharedSecret = Buffer.from(rsa.decrypt(encSecret) as Buffer)
            const verifyTokenDecrypted = Buffer.from(rsa.decrypt(encToken) as Buffer)

            if (verifyTokenDecrypted.length !== verifyToken.length || !timingSafeEqual(verifyTokenDecrypted, verifyToken)) {
              consola.error("Invalid verify token.")
              socket.destroy()
              return
            }

            if (sharedSecret.length !== 16) {
              consola.error("Invalid shared secret length.")
              socket.destroy()
              return
            }

            consola.debug("Enabling encryption...")
            aesDec.enable(sharedSecret)
            aesEnc.enable(sharedSecret)

            this.yggdrasilServer.hasJoined(gameProfile.username, "", sharedSecret, this.publicKey, (err: any, profile: any) => {
              if (err) {
                consola.error(`Authentication failed: ${err.message}`)
                socket.destroy()
                return
              }

              if (!profile || !profile.id || !profile.name) {
                consola.error("Invalid profile received from authentication.")
                socket.destroy()
                return
              }

              gameProfile!.playerUUID = dashedUUID(profile.id)

              const threshold = this.options.compressionThreshold ?? 256
              serializer.write({
                name: "compress",
                params: { threshold }
              })
              framingDecoder.setThreshold(threshold)
              framingEncoder.setThreshold(threshold)

              serializer.write({
                name: "success",
                params: {
                  uuid: gameProfile!.playerUUID,
                  username: profile.name,
                  properties: profile.properties
                }
              })

              if (mcData!.version["<"]("1.20.2")) {
                setState(mc.states.PLAY)
              }

              remoteClient = new Client({
                host: this.options.remoteHost ?? "localhost",
                port: this.options.remotePort ?? 25566,
                username: gameProfile!.username,
                version
              })

              remoteClient.on("login", () => {
                consola.info(`Logged in on remote server as ${gameProfile!.username}.`)
              })

              remoteClient.on("packet", (msg: any) => {
                serializer.write(msg.data)
              })

              remoteClient.on("disconnect", (reason: any) => {
                serializer.write(reason.data)
                socket.destroy()
              })

              remoteClient.connect()
            })
          } else if (packet.data.name === "login_acknowledged") {
            setState(mc.states.CONFIGURATION)
          }
          break
        }

        case mc.states.PLAY: {
          if (remoteClient) {
            if (packet.data.name === "configuration_acknowledged") {
              setState(mc.states.CONFIGURATION)
              remoteClient.write(packet.data)
              remoteClient.setState(mc.states.CONFIGURATION)
            } else {
              remoteClient.write(packet.data)
            }
          }
          break
        }

        case mc.states.CONFIGURATION: {
          if (remoteClient) {
            if (packet.data.name === "finish_configuration") {
              setState(mc.states.PLAY)
              remoteClient.write(packet.data)
              remoteClient.setState(mc.states.PLAY)
            } else {
              remoteClient.write(packet.data)
            }
          }
          break
        }
      }
    }

    deserializer.on("data", onPacket)

    const setState = (next: mc.States) => {
      if (state === next) return
      consola.debug(`Server switching state to ${next}.`)

      try {
        framingDecoder.unpipe(deserializer)
      } catch {
      }
      try {
        serializer.unpipe(framingEncoder)
      } catch {
      }
      deserializer.removeListener("data", onPacket)

      const codec = makeMinecraftCodecs(next, version.name, true)
      serializer = codec.serializer
      deserializer = codec.deserializer
      state = next

      framingDecoder.pipe(deserializer)
      serializer.pipe(framingEncoder)
      deserializer.on("data", onPacket)
    }
  }
}