import { PeerError } from './errors.ts'

/** What the codec carries: JSON-like values plus raw bytes, with no base64 and no text round trip for payloads */
export type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value }

// One tag byte per value
const Tag = { Null: 0, False: 1, True: 2, Int: 3, Float: 4, String: 5, Bytes: 6, Array: 7, Map: 8 } as const

const MaxDepth = 32
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Growable output buffer */
export class Writer {
  private _bytes: Uint8Array
  private _view: DataView
  length = 0

  constructor(size = 256) {
    this._bytes = new Uint8Array(size)
    this._view = new DataView(this._bytes.buffer)
  }

  private reserve(extra: number) {
    const need = this.length + extra
    if (need <= this._bytes.length) return
    let size = this._bytes.length * 2
    while (size < need) size *= 2
    const next = new Uint8Array(size)
    next.set(this._bytes.subarray(0, this.length))
    this._bytes = next
    this._view = new DataView(next.buffer)
  }

  u8(value: number) { this.reserve(1); this._bytes[this.length++] = value }
  u32(value: number) { this.reserve(4); this._view.setUint32(this.length, value); this.length += 4 }
  f64(value: number) { this.reserve(8); this._view.setFloat64(this.length, value); this.length += 8 }

  /** Unsigned LEB128; safe integers only */
  varuint(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new PeerError('protocol', `not an unsigned integer: ${value}`)
    this.reserve(10)
    while (value >= 0x80) {
      this._bytes[this.length++] = (value % 0x80) | 0x80
      value = Math.floor(value / 0x80)
    }
    this._bytes[this.length++] = value
  }

  raw(bytes: Uint8Array) { this.reserve(bytes.length); this._bytes.set(bytes, this.length); this.length += bytes.length }

  finish() { return this._bytes.slice(0, this.length) }
}

/** Reads from a buffer; every read is bounds-checked, so a truncated or lying frame is a `protocol` error, never a crash */
export class Reader {
  private _view: DataView
  offset = 0

  constructor(readonly bytes: Uint8Array) {
    this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining() { return this.bytes.length - this.offset }

  private need(count: number) {
    if (count < 0 || this.offset + count > this.bytes.length) throw new PeerError('protocol', 'frame is truncated')
  }

  u8() { this.need(1); return this.bytes[this.offset++]! }
  u32() { this.need(4); const value = this._view.getUint32(this.offset); this.offset += 4; return value }
  f64() { this.need(8); const value = this._view.getFloat64(this.offset); this.offset += 8; return value }

  varuint() {
    let result = 0
    let scale = 1
    for (let index = 0; index < 8; index++) {
      const byte = this.u8()
      result += (byte & 0x7f) * scale
      if (!(byte & 0x80)) return result
      scale *= 0x80
    }
    throw new PeerError('protocol', 'integer is too long')
  }

  /** A view into the buffer (no copy) */
  take(count: number) { this.need(count); const view = this.bytes.subarray(this.offset, this.offset + count); this.offset += count; return view }
  rest() { return this.take(this.remaining) }
}

/** Integers go as zigzag varints (up to 2^52), everything else numeric as a float64 */
function encodeNumber(out: Writer, value: number) {
  if (Number.isInteger(value) && Math.abs(value) < 2 ** 52 && !Object.is(value, -0)) {
    out.u8(Tag.Int)
    out.varuint(value < 0 ? -value * 2 - 1 : value * 2)
  } else {
    out.u8(Tag.Float)
    out.f64(value)
  }
}

export function writeValue(out: Writer, value: Value, depth = 0): void {
  if (depth > MaxDepth) throw new PeerError('limit', 'value is nested too deeply')
  if (value === null || value === undefined) return out.u8(Tag.Null)
  switch (typeof value) {
    case 'boolean': return out.u8(value ? Tag.True : Tag.False)
    case 'number': return encodeNumber(out, value)
    case 'string': {
      const bytes = encoder.encode(value)
      out.u8(Tag.String); out.varuint(bytes.length); out.raw(bytes)
      return
    }
    case 'object': {
      if (value instanceof Uint8Array) { out.u8(Tag.Bytes); out.varuint(value.length); out.raw(value); return }
      if (Array.isArray(value)) {
        out.u8(Tag.Array); out.varuint(value.length)
        for (const item of value) writeValue(out, item, depth + 1)
        return
      }
      // A key whose value is undefined is left out, as JSON does
      const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      out.u8(Tag.Map); out.varuint(entries.length)
      for (const [key, item] of entries) {
        const bytes = encoder.encode(key)
        out.varuint(bytes.length); out.raw(bytes)
        writeValue(out, item, depth + 1)
      }
      return
    }
    default: throw new PeerError('protocol', `cannot encode a ${typeof value}`)
  }
}

export function readValue(input: Reader, depth = 0): Value {
  if (depth > MaxDepth) throw new PeerError('limit', 'value is nested too deeply')
  const tag = input.u8()
  switch (tag) {
    case Tag.Null: return null
    case Tag.False: return false
    case Tag.True: return true
    case Tag.Int: { const raw = input.varuint(); return raw % 2 ? -(raw + 1) / 2 : raw / 2 }
    case Tag.Float: return input.f64()
    case Tag.String: return readString(input)
    case Tag.Bytes: return input.take(input.varuint())
    case Tag.Array: {
      const count = input.varuint()
      // Every item takes at least one byte, so a count beyond what is left is a lie, not a reason to allocate
      if (count > input.remaining) throw new PeerError('protocol', 'array is longer than the frame')
      const items: Value[] = []
      for (let index = 0; index < count; index++) items.push(readValue(input, depth + 1))
      return items
    }
    case Tag.Map: {
      const count = input.varuint()
      if (count > input.remaining) throw new PeerError('protocol', 'map is longer than the frame')
      // No prototype: a key such as `__proto__` is just data
      const map: { [key: string]: Value } = Object.create(null)
      for (let index = 0; index < count; index++) {
        const key = readString(input, false)
        map[key] = readValue(input, depth + 1)
      }
      return map
    }
    default: throw new PeerError('protocol', `unknown value tag ${tag}`)
  }
}

function readString(input: Reader, tagged = true) {
  const length = input.varuint()
  const bytes = input.take(length)
  try { return decoder.decode(bytes) } catch { throw new PeerError('protocol', `string is not valid UTF-8${tagged ? '' : ' (key)'}`) }
}

export function encodeValue(value: Value): Uint8Array {
  const out = new Writer()
  writeValue(out, value)
  return out.finish()
}

export function decodeValue(bytes: Uint8Array): Value {
  const input = new Reader(bytes)
  const value = readValue(input)
  if (input.remaining) throw new PeerError('protocol', 'trailing bytes after value')
  return value
}
