# MC Proxy

**MC-Proxy** is a library to proxy Minecraft connections via a localhost server. 
This allows for packet deletion / insertion / manipulation.
The proxy, in theory, can handle any game version which [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol)
supports. This only breaks when logic changes occur (such as the configuration state introduced in 1.20.2),
these will need to be manually implemented. As of now, it supports **1.7 - 1.21.8**.

## Installation

## Usage

This is a minimal example which logs all chat messages sent by a client (can also be found in examples/basic_proxy):

```js
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
```