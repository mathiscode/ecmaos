/**
 * OpenPGP packets (RFC 4880 4) and ASCII armor (6): reading both header formats and partial body lengths, writing the
 * new format, MPIs, and armor with its CRC-24.
 */

import { concat } from './crypto.mjs'

export const TAG = { PKESK: 1, SIGNATURE: 2, SKESK: 3, ONE_PASS: 4, SECRET_KEY: 5, PUBLIC_KEY: 6, SECRET_SUBKEY: 7, COMPRESSED: 8, SED: 9, MARKER: 10, LITERAL: 11, TRUST: 12, USER_ID: 13, PUBLIC_SUBKEY: 14, USER_ATTRIBUTE: 17, SEIPD: 18, MDC: 19 }

/** The packets in `bytes`: `[{ tag, body }]` */
export function readPackets(bytes) {
  const packets = []
  let at = 0
  while (at < bytes.length) {
    const head = bytes[at++]
    if (!(head & 0x80)) throw new Error('invalid packet (not an OpenPGP packet header)')
    let tag, body
    if (head & 0x40) {
      tag = head & 0x3f
      const parts = []
      for (;;) {
        const first = bytes[at++]
        let length
        if (first < 192) length = first
        else if (first < 224) length = ((first - 192) << 8) + bytes[at++] + 192
        else if (first === 255) { length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0; at += 4 }
        else {
          // a partial body: this much now, and a length after it
          const partial = 1 << (first & 0x1f)
          parts.push(bytes.subarray(at, at + partial))
          at += partial
          continue
        }
        parts.push(bytes.subarray(at, at + length))
        at += length
        break
      }
      body = parts.length === 1 ? parts[0] : concat(...parts)
    } else {
      tag = (head >> 2) & 0x0f
      const type = head & 3
      let length
      if (type === 0) length = bytes[at++]
      else if (type === 1) { length = (bytes[at] << 8) | bytes[at + 1]; at += 2 }
      else if (type === 2) { length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0; at += 4 }
      else length = bytes.length - at
      body = bytes.subarray(at, at + length)
      at += length
    }
    if (at > bytes.length) throw new Error('invalid packet (truncated)')
    packets.push({ tag, body })
  }
  return packets
}

/** A packet in the new format */
export function packet(tag, body) {
  const n = body.length
  const length = n < 192 ? Uint8Array.of(n) : n < 8384 ? Uint8Array.of(((n - 192) >> 8) + 192, (n - 192) & 0xff) : Uint8Array.of(255, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  return concat(Uint8Array.of(0xc0 | tag), length, body)
}

/** A reader over a packet's body */
export class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0 }
  get left() { return this.bytes.length - this.at }
  u8() { if (this.at >= this.bytes.length) throw new Error('invalid packet (too short)'); return this.bytes[this.at++] }
  u16() { return (this.u8() << 8) | this.u8() }
  u32() { return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0 }
  take(n) { if (n > this.left) throw new Error('invalid packet (too short)'); const out = this.bytes.subarray(this.at, this.at + n); this.at += n; return out }
  rest() { return this.take(this.left) }
  /** A multiprecision integer, as its bytes */
  mpi() { const bits = this.u16(); return this.take((bits + 7) >> 3) }
}

export const u16 = n => Uint8Array.of((n >> 8) & 0xff, n & 0xff)
export const u32 = n => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)

/** An MPI of `bytes`: its bit length, then the bytes without leading zeros */
export function mpi(bytes) {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const trimmed = bytes.subarray(start)
  const bits = trimmed.length ? (trimmed.length - 1) * 8 + (trimmed[0] ? Math.floor(Math.log2(trimmed[0])) + 1 : 0) : 0
  return concat(u16(bits), trimmed)
}

// Armor ----------------------------------------------------------------------------------------------------------------

function crc24(bytes) {
  let crc = 0xb704ce
  for (const byte of bytes) {
    crc ^= byte << 16
    for (let i = 0; i < 8; i++) {
      crc <<= 1
      if (crc & 0x1000000) crc ^= 0x1864cfb
    }
  }
  return crc & 0xffffff
}

const toBase64 = bytes => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0))

/** `-----BEGIN PGP <kind>-----` armor around `bytes`, with the checksum */
export function armor(kind, bytes, headers = {}) {
  const body = toBase64(bytes).match(/.{1,64}/g) ?? []
  const crc = crc24(bytes)
  const lines = [`-----BEGIN PGP ${kind}-----`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', ...body, '=' + btoa(String.fromCharCode((crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff)), `-----END PGP ${kind}-----`]
  return lines.join('\n') + '\n'
}

/** Whether text looks armored */
export const isArmored = bytes => /-----BEGIN PGP /.test(new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))))

/**
 * The armored blocks in `text`: `[{ kind, headers, bytes }]`. A signed message's cleartext comes as `{ kind: 'SIGNED
 * MESSAGE', headers, text }`, its signature as the block after it.
 */
export function dearmor(text) {
  const blocks = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const begin = /^-----BEGIN PGP (.+)-----\s*$/.exec(lines[i])
    if (!begin) continue
    const kind = begin[1]
    const headers = {}
    i++
    while (i < lines.length && lines[i].trim() !== '') {
      const header = /^([^:]+):\s?(.*)$/.exec(lines[i])
      if (header) headers[header[1]] = header[2]
      i++
    }
    i++
    if (kind === 'SIGNED MESSAGE') {
      const body = []
      while (i < lines.length && !/^-----BEGIN PGP SIGNATURE-----/.test(lines[i])) body.push(lines[i++])
      i--
      // the cleartext's dashes are escaped; the line break before the signature's line is not the text's, which joining
      // the lines already leaves out
      blocks.push({ kind, headers, text: body.map(line => line.replace(/^- /, '')).join('\n') })
      continue
    }
    const data = []
    let checksum
    while (i < lines.length && !/^-----END PGP /.test(lines[i])) {
      const line = lines[i++].trim()
      if (line.startsWith('=') && line.length === 5) checksum = line.slice(1)
      else if (line) data.push(line)
    }
    const bytes = fromBase64(data.join(''))
    if (checksum !== undefined) {
      const crc = crc24(bytes)
      if (btoa(String.fromCharCode((crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff)) !== checksum) throw new Error('CRC error; the armor is damaged')
    }
    blocks.push({ kind, headers, bytes })
  }
  if (!blocks.length) throw new Error('no valid OpenPGP data found')
  return blocks
}

/** The binary OpenPGP data of a file that may be armored */
export function binaryOf(bytes) {
  if (!isArmored(bytes)) return bytes
  return concat(...dearmor(new TextDecoder().decode(bytes)).filter(block => block.bytes).map(block => block.bytes))
}

export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
