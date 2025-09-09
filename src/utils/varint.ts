export function readVarInt(buf: Buffer, offset = 0) {
  let num = 0, shift = 0, pos = offset
  for (; ;) {
    const b = buf[pos++]
    num |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 35) throw new Error("VarInt too big")
  }
  return { value: num, size: pos - offset }
}

export function writeVarInt(value: number) {
  const out = []
  let v = value >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return Buffer.from(out)
}