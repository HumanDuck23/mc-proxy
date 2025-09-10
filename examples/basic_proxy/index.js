import { Server } from "mc-proxy"

const server = new Server({
  port: 25566,
  motd: "A Basic Proxy Server",
  remotePort: 25565
})

server.on("incoming", (client, remoteClient, packet, cb) => {
  // Pass through all packets
  cb(true)
})

server.on("outgoing", (client, remoteClient, packet, cb) => {
  if (packet.data.name === "chat_message" || packet.data.name === "chat") {
    console.log(`Chat message: ${packet.data.params.message}`)
  }
  cb(true)
})

server.start()