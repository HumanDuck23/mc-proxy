import { FramingOptions } from "./FramingOptions.js"
import { Transform, TransformCallback } from "node:stream"
import { writeVarInt } from "../utils/varint.js"
import { deflateSync } from "node:zlib"

export class FramingEncoder extends Transform {
  private threshold: number

  constructor({ threshold = -1 }: FramingOptions = {}) {
    super({
      readableObjectMode: false,
      writableObjectMode: true,
    })
    this.threshold = threshold
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold
  }

  frame(payload: Buffer): Buffer {
    if (this.threshold === -1) {
      const len = writeVarInt(payload.length)
      return Buffer.concat([len, payload])
    }

    const uncompressedLen = payload.length

    if (uncompressedLen >= this.threshold) {
      const compressed = deflateSync(payload)
      const inner = writeVarInt(uncompressedLen)
      const body = Buffer.concat([inner, compressed])
      const outer = writeVarInt(body.length)
      return Buffer.concat([outer, body])
    } else {
      const inner = writeVarInt(0)
      const body = Buffer.concat([inner, payload])
      const outer = writeVarInt(body.length)
      return Buffer.concat([outer, body])
    }
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error("FramingEncoder expects Buffer payloads (one per write).")
      }
      this.push(this.frame(chunk))
      cb()
    } catch (e) {
      cb(e as Error)
    }
  }
}