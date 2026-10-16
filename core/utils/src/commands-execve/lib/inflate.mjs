/**
 * DEFLATE decompression (RFC 1951), written out so the caller learns where the compressed data ends: what a gzip file made of
 * several members, or a zip entry, needs and what the platform's stream does not say. It follows zlib's `puff`.
 */

export class InflateError extends Error {}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** A canonical Huffman code from the lengths of its symbols: `{ count, symbol }` as puff builds them */
function construct(lengths, n) {
  const count = new Uint16Array(16)
  for (let i = 0; i < n; i++) count[lengths[i]]++
  const symbol = new Uint16Array(n)
  const offsets = new Uint16Array(16)
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + count[len]
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offsets[lengths[i]]++] = i
  let left = 1
  for (let len = 1; len <= 15; len++) {
    left <<= 1
    left -= count[len]
    if (left < 0) throw new InflateError('invalid compressed data--format violated')
  }
  return { count, symbol, incomplete: left > 0 }
}

let fixed

function fixedTables() {
  if (fixed) return fixed
  const lengths = new Uint8Array(288)
  let i = 0
  for (; i < 144; i++) lengths[i] = 8
  for (; i < 256; i++) lengths[i] = 9
  for (; i < 280; i++) lengths[i] = 7
  for (; i < 288; i++) lengths[i] = 8
  const distances = new Uint8Array(30).fill(5)
  fixed = { literal: construct(lengths, 288), distance: construct(distances, 30) }
  return fixed
}

/**
 * Decompresses the DEFLATE stream that starts at `bytes[start]`. `{ data, end }`: the output and the offset of the first byte
 * after the stream.
 */
export function inflate(bytes, start = 0) {
  let position = start
  let bitBuffer = 0
  let bitCount = 0
  let out = new Uint8Array(Math.max(1024, bytes.length * 3))
  let length = 0

  const bits = need => {
    let value = bitBuffer
    while (bitCount < need) {
      if (position >= bytes.length) throw new InflateError('unexpected end of file')
      value |= bytes[position++] << bitCount
      bitCount += 8
    }
    bitBuffer = value >>> need
    bitCount -= need
    return value & ((1 << need) - 1)
  }

  const decode = h => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len <= 15; len++) {
      code |= bits(1)
      const count = h.count[len]
      if (code - count < first) return h.symbol[index + (code - first)]
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new InflateError('invalid compressed data--format violated')
  }

  const ensure = extra => {
    if (length + extra <= out.length) return
    const bigger = new Uint8Array(Math.max(out.length * 2, length + extra))
    bigger.set(out.subarray(0, length))
    out = bigger
  }

  const codes = (literal, distance) => {
    for (;;) {
      let symbol = decode(literal)
      if (symbol < 256) { ensure(1); out[length++] = symbol; continue }
      if (symbol === 256) return
      symbol -= 257
      if (symbol >= 29) throw new InflateError('invalid compressed data--format violated')
      const len = LENGTH_BASE[symbol] + bits(LENGTH_EXTRA[symbol])
      const distanceSymbol = decode(distance)
      if (distanceSymbol >= 30) throw new InflateError('invalid compressed data--format violated')
      const dist = DISTANCE_BASE[distanceSymbol] + bits(DISTANCE_EXTRA[distanceSymbol])
      if (dist > length) throw new InflateError('invalid compressed data--format violated')
      ensure(len)
      for (let k = 0; k < len; k++, length++) out[length] = out[length - dist]
    }
  }

  let last
  do {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      bitBuffer = 0
      bitCount = 0
      if (position + 4 > bytes.length) throw new InflateError('unexpected end of file')
      const len = bytes[position] | (bytes[position + 1] << 8)
      const inverse = bytes[position + 2] | (bytes[position + 3] << 8)
      if (len !== (~inverse & 0xffff)) throw new InflateError('invalid compressed data--format violated')
      position += 4
      if (position + len > bytes.length) throw new InflateError('unexpected end of file')
      ensure(len)
      out.set(bytes.subarray(position, position + len), length)
      length += len
      position += len
    } else if (type === 1) {
      const { literal, distance } = fixedTables()
      codes(literal, distance)
    } else if (type === 2) {
      const nlen = bits(5) + 257
      const ndist = bits(5) + 1
      const ncode = bits(4) + 4
      if (nlen > 286 || ndist > 30) throw new InflateError('invalid compressed data--format violated')
      const lengths = new Uint8Array(320)
      for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i]] = bits(3)
      const lencode = construct(lengths.subarray(0, 19), 19)
      if (lencode.incomplete) throw new InflateError('invalid compressed data--format violated')
      const all = new Uint8Array(nlen + ndist)
      let index = 0
      while (index < nlen + ndist) {
        let symbol = decode(lencode)
        if (symbol < 16) all[index++] = symbol
        else {
          let previous = 0
          let repeat
          if (symbol === 16) {
            if (index === 0) throw new InflateError('invalid compressed data--format violated')
            previous = all[index - 1]
            repeat = 3 + bits(2)
          } else if (symbol === 17) repeat = 3 + bits(3)
          else repeat = 11 + bits(7)
          if (index + repeat > nlen + ndist) throw new InflateError('invalid compressed data--format violated')
          while (repeat--) all[index++] = previous
        }
      }
      if (all[256] === 0) throw new InflateError('invalid compressed data--format violated')
      const literal = construct(all.subarray(0, nlen), nlen)
      const distance = construct(all.subarray(nlen), ndist)
      codes(literal, distance)
    } else throw new InflateError('invalid compressed data--format violated')
  } while (!last)
  return { data: out.slice(0, length), end: position }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** The CRC-32 of `bytes` (what gzip and zip store), continuing from `crc` */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
