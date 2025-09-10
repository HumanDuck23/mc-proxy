import { Transform, TransformCallback } from "node:stream"
import { createCipheriv, Cipheriv } from "node:crypto"

export class AesEncoder extends Transform {
  private cipher: Cipheriv | null = null

  constructor() {
    super({ readableObjectMode: false, writableObjectMode: false })
  }

  enable(sharedSecret: Buffer) {
    if (sharedSecret.length !== 16) {
      throw new Error(`AES sharedSecret must be 16 bytes, got ${sharedSecret.length}`)
    }
    this.cipher = createCipheriv("aes-128-cfb8", sharedSecret, sharedSecret)
  }

  disable() {
    this.cipher = null
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      if (!this.cipher) {
        this.push(chunk)
        return cb()
      }
      this.push(this.cipher.update(chunk))
      cb()
    } catch (e) {
      cb(e as Error)
    }
  }

  _flush(cb: TransformCallback) {
    cb()
  }
}