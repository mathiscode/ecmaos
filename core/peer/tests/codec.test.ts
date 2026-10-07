import { describe, expect, it } from 'vitest'
import { decodeValue, encodeValue, PeerError, Reader, Writer } from '../src/index.ts'
import type { Value } from '../src/index.ts'

const roundTrip = (value: Value) => decodeValue(encodeValue(value))

describe('codec', () => {
  it('round trips scalars', () => {
    for (const value of [null, true, false, 0, 1, -1, 63, -64, 2 ** 31, -(2 ** 31), 2 ** 51, -(2 ** 51), 1.5, -0.25, 1e300, '', 'héllo \u{1F600}']) {
      expect(roundTrip(value)).toEqual(value)
    }
  })

  it('keeps negative zero, infinities and NaN as floats', () => {
    expect(Object.is(roundTrip(-0), -0)).toBe(true)
    expect(roundTrip(Infinity)).toBe(Infinity)
    expect(roundTrip(NaN)).toBeNaN()
    expect(roundTrip(2 ** 60)).toBe(2 ** 60)
  })

  it('round trips bytes without copying through text', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => index % 256)
    const back = roundTrip(bytes) as Uint8Array
    expect(back).toBeInstanceOf(Uint8Array)
    expect([...back]).toEqual([...bytes])
  })

  it('round trips nested arrays and maps', () => {
    const value = { a: [1, 'two', { three: new Uint8Array([3]) }], b: null, c: { d: true } }
    expect(roundTrip(value)).toEqual(value)
  })

  it('leaves out undefined keys, as JSON does', () => {
    expect(roundTrip({ a: 1, b: undefined as unknown as Value })).toEqual({ a: 1 })
  })

  it('treats __proto__ as plain data', () => {
    const out = new Writer()
    // a map with the single key __proto__
    out.u8(8); out.varuint(1); out.varuint(9); out.raw(new TextEncoder().encode('__proto__')); out.u8(2)
    const value = decodeValue(out.finish()) as Record<string, Value>
    expect(Object.getPrototypeOf(value)).toBe(null)
    expect(value['__proto__']).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects truncated input', () => {
    const full = encodeValue({ key: 'a long enough string value', list: [1, 2, 3] })
    for (let length = 0; length < full.length; length++) {
      expect(() => decodeValue(full.subarray(0, length))).toThrow(PeerError)
    }
  })

  it('rejects trailing bytes and unknown tags', () => {
    expect(() => decodeValue(Uint8Array.from([0, 0]))).toThrow(/trailing/)
    expect(() => decodeValue(Uint8Array.from([99]))).toThrow(/unknown value tag/)
  })

  it('rejects invalid UTF-8', () => {
    expect(() => decodeValue(Uint8Array.from([5, 2, 0xc3, 0x28]))).toThrow(/UTF-8/)
  })

  it('does not allocate for a lying length', () => {
    // an array claiming 2^40 items in a 10 byte frame
    const out = new Writer()
    out.u8(7); out.varuint(2 ** 40)
    expect(() => decodeValue(out.finish())).toThrow(/longer than the frame/)
    const bytes = new Writer()
    bytes.u8(6); bytes.varuint(2 ** 40)
    expect(() => decodeValue(bytes.finish())).toThrow(PeerError)
  })

  it('limits nesting', () => {
    let value: Value = 1
    for (let depth = 0; depth < 50; depth++) value = [value]
    expect(() => encodeValue(value)).toThrow(/nested/)
    const deep = new Uint8Array(100).fill(7).map((tag, index) => index % 2 ? 1 : tag) // array(1) array(1) ...
    expect(() => decodeValue(deep)).toThrow(PeerError)
  })

  it('varuint round trips and rejects overlong encodings', () => {
    for (const value of [0, 1, 127, 128, 16383, 16384, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      const out = new Writer()
      out.varuint(value)
      expect(new Reader(out.finish()).varuint()).toBe(value)
    }
    expect(() => new Reader(new Uint8Array(12).fill(0x80)).varuint()).toThrow(/too long/)
    expect(() => new Writer().varuint(-1)).toThrow(PeerError)
    expect(() => new Writer().varuint(1.5)).toThrow(PeerError)
  })

  it('survives random garbage with only PeerErrors', () => {
    let seed = 12345
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    for (let run = 0; run < 2000; run++) {
      const bytes = Uint8Array.from({ length: next() % 40 }, () => next() % 256)
      try { decodeValue(bytes) } catch (error) { expect(error).toBeInstanceOf(PeerError) }
    }
  })
})
