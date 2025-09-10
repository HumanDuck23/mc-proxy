import { Transform, TransformCallback } from "node:stream"
import { createDecipheriv, Decipheriv } from "node:crypto"

export class AesDecoder extends Transform {
  private decipher: Decipheriv | null = null

  constructor() {
    super({ readableObjectMode: false, writableObjectMode: false })
  }

  enable(sharedSecret: Buffer) {
    if (sharedSecret.length !== 16) {
      throw new Error(`AES sharedSecret must be 16 bytes, got ${sharedSecret.length}`)
    }
    this.decipher = createDecipheriv("aes-128-cfb8", sharedSecret, sharedSecret)
  }

  disable() {
    this.decipher = null
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      if (!this.decipher) {
        this.push(chunk)
        return cb()
      }
      this.push(this.decipher.update(chunk))
      cb()
    } catch (e) {
      cb(e as Error)
    }
  }

  _flush(cb: TransformCallback) {
    cb()
  }
}