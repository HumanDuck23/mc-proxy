# MC Proxy

**MC-Proxy** is a library to proxy Minecraft connections via a localhost server. 
This allows for packet deletion / insertion / manipulation.
The proxy, in theory, can handle any game version which [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol)
supports. This only breaks when logic changes occur (such as the configuration state introduced in 1.20.2),
these will need to be manually implemented. As of now, it supports **1.7 - 1.21.8**.

