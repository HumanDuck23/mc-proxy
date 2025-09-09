import { Transform, TransformCallback } from "node:stream"
import { inflateSync } from "node:zlib"

import { FramingOptions } from "./FramingOptions.js"
import { readVarInt } from "../utils/varint.js"


/**
 * Transform to make sure only full packets are passed on
 */
export class FramingDecoder extends Transform {
  private buffer: Buffer = Buffer.alloc(0)
  private threshold: number

  constructor({ threshold = -1 }: FramingOptions = {}) {
    super({ readableObjectMode: false, writableObjectMode: false })
    this.threshold = threshold
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])

      for (; ;) {
        if (this.buffer.length === 0) break
        let lenHdr
        try {
          lenHdr = readVarInt(this.buffer, 0)
        } catch {
          break
        }

        const packetLength = lenHdr.value >>> 0
        const totalNeeded = lenHdr.size + packetLength

        if (this.buffer.length < totalNeeded) break

        const packetData = this.buffer.subarray(lenHdr.size, totalNeeded)

        this.buffer = this.buffer.subarray(totalNeeded)

        if (this.threshold === -1) {
          this.push(packetData)
          continue
        }

        let innerHdr
        try {
          innerHdr = readVarInt(packetData, 0)
        } catch {
          throw new Error("Malformed packet: missing inner VarInt")
        }

        const uncompressedLength = innerHdr.value >>> 0
        const content = packetData.subarray(innerHdr.size)

        if (uncompressedLength === 0) {
          this.push(content)
        } else {
          const decompressed = inflateSync(content)
          this.push(decompressed)
        }
      }

      cb()
    } catch (err) {
      cb(err as Error)
    }
  }

  _flush(cb: TransformCallback): void {
    this.buffer = Buffer.alloc(0)
    cb()
  }
}