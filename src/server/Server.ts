import { EventEmitter } from "node:events"
import mc from "minecraft-protocol"
import mcData from "minecraft-data"
import { consola } from "consola"
import * as net from "node:net"

import { makeMinecraftCodecs } from "../codec/makeMinecraftCodecs.js"
import { FramingDecoder } from "../codec/FramingDecoder.js"
import { FramingEncoder } from "../codec/FramingEncoder.js"

export type ServerOptions = {
  port?: number
  host?: string

  motd?: string
  maxPlayers?: number
  favicon?: string
}

/**
 * Wraps a node:net server to handle Minecraft packets
 */
export class Server extends EventEmitter {
  private options: ServerOptions
  private server: net.Server
  private defaultVersion = { name: "1.21.8", protocol: 772 as number }

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
  }

  private handleConnection(socket: net.Socket) {
    consola.debug(`Connection from ${socket.remoteAddress}.`)

    let state: mc.States = mc.states.HANDSHAKING
    let version = { ...this.defaultVersion }

    const framingDecoder = new FramingDecoder()
    const framingEncoder = new FramingEncoder()

    let { serializer, deserializer } = makeMinecraftCodecs(state, version.name, true)

    socket.pipe(framingDecoder)
    framingEncoder.pipe(socket)

    framingDecoder.pipe(deserializer)
    serializer.pipe(framingEncoder)

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
    socket.on("end", () => consola.info(`Client ${socket.remoteAddress} disconnected.`))
    socket.on("close", cleanup)

    const onPacket = (packet: any) => {
      switch (state) {
        case mc.states.HANDSHAKING: {
          if (packet.data.name === "set_protocol") {
            const versions = mcData.postNettyVersionsByProtocolVersion.pc
            const protocolVersion = String(packet.data.params.protocolVersion)

            // @ts-ignore
            const mcVersion = (versions[protocolVersion] ?? [null])[0]

            if (mcVersion) {
              version = { name: mcVersion.minecraftVersion, protocol: Number(protocolVersion) }
              consola.info(`Client version ${version.name} (${version.protocol}).`)
            } else {
              consola.warn(`Unknown protocol ${protocolVersion}, keeping default ${version.name}`)
            }

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
          break
        }

        case mc.states.PLAY: {
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