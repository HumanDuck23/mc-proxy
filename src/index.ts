import { consola } from "consola"
consola.level = 5

import { Server } from "./server/Server.js"

const s = new Server({})
s.start()