import { Server } from "mc-proxy"

const server = new Server({
  port: 25566,
  motd: "A Basic Proxy Server",
  remotePort: 25565
})

server.start()