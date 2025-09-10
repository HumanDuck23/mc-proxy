import { EventEmitter } from "node:events"
import mc from "minecraft-protocol"
import { consola } from "consola"
import * as net from "node:net"

import { FramingDecoder } from "../codec/FramingDecoder.js"
import { FramingEncoder } from "../codec/FramingEncoder.js"
import { makeMinecraftCodecs } from "../codec/makeMinecraftCodecs.js"

export type ClientOptions = {
  host: string
  version: { name: string, protocol: number }
  username: string
  port?: number
}

/**
 * Client class that can connect to a Minecraft server and handle packets.
 */
export class Client extends EventEmitter {
  private options: ClientOptions
  private client: net.Socket

  private framingDecoder = new FramingDecoder()
  private framingEncoder = new FramingEncoder()

  private serializer: any | null = null
  private deserializer: any | null = null

  private state: mc.States = mc.states.HANDSHAKING

  private readonly handlePacket = (packet: any) => this.onPacket(packet)

  constructor(options: ClientOptions) {
    super()
    this.options = options
    this.client = new net.Socket()
  }

  connect() {
    const port = this.options.port ?? 25565

    this.client.pipe(this.framingDecoder)
    this.framingEncoder.pipe(this.client)

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

      // TODO: Login sequence
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

  }
}