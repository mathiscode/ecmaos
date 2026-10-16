/**
 * The zip file format: reading the central directory and the entries it names, and writing a new archive (local headers, data,
 * central directory, end record) the way Info-ZIP does: deflated data unless that is no smaller, DOS dates in local time, the
 * Unix attributes in the high half of the external attributes and the extended-timestamp field.
 */

import { crc32, inflate } from './inflate.mjs'
import { joinChunks } from './bytes.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class ZipError extends Error {}

export async function deflateRaw(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')).getReader()
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return joinChunks(chunks)
}

function dosTime(ms) {
  const d = new Date(ms)
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/** The time a DOS date and time stand for, in local time, in milliseconds */
export function fromDos(date, time) {
  return new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0xf) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime()
}

/** `{ entries, comment, size }` of a zip file's central directory; throws `ZipError` when it is not one */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new ZipError('End-of-central-directory signature not found')
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const comment = decoder.decode(bytes.subarray(eocd + 22, eocd + 22 + view.getUint16(eocd + 20, true)))
  const entries = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new ZipError('central directory is damaged')
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const flags = view.getUint16(at + 8, true)
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength)
    entries.push({
      versionMade: view.getUint16(at + 4, true),
      versionNeeded: view.getUint16(at + 6, true),
      flags,
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      internalAttr: view.getUint16(at + 36, true),
      externalAttr: view.getUint32(at + 38, true),
      offset: view.getUint32(at + 42, true),
      name: decoder.decode(nameBytes),
      extra: bytes.slice(at + 46 + nameLength, at + 46 + nameLength + extraLength),
      comment: decoder.decode(bytes.subarray(at + 46 + nameLength + extraLength, at + 46 + nameLength + extraLength + commentLength))
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return { entries, comment, size: bytes.length }
}

/** The mtime (in seconds) from an extended-timestamp field, when the entry has one */
export function extraTime(extra) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.length)
  for (let at = 0; at + 4 <= extra.length;) {
    const id = view.getUint16(at, true)
    const size = view.getUint16(at + 2, true)
    if (id === 0x5455 && size >= 5 && (extra[at + 4] & 1)) return view.getUint32(at + 5, true)
    at += 4 + size
  }
  return undefined
}

/** The bytes of one entry, decompressed and checked against its CRC; `ZipError` with `unzip`'s wording when it fails */
export function entryData(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  const at = entry.offset
  if (view.getUint32(at, true) !== 0x04034b50) throw new ZipError('bad local header')
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
  if (entry.flags & 1) throw new ZipError('encrypted entries are not supported')
  let data
  if (entry.method === 0) data = bytes.subarray(start, start + entry.compressedSize)
  else if (entry.method === 8) {
    try { data = inflate(bytes.subarray(0, start + entry.compressedSize), start).data } catch { throw new ZipError('bad zipfile offset') }
  } else throw new ZipError(`unsupported compression method ${entry.method}`)
  if (data.length !== entry.size) throw new ZipError('bad zipfile offset')
  if (crc32(data) !== entry.crc) throw new ZipError('bad CRC')
  return data
}

const isText = bytes => {
  const limit = Math.min(bytes.length, 4096)
  for (let i = 0; i < limit; i++) { const b = bytes[i]; if (b === 0 || (b < 7) || (b > 13 && b < 32 && b !== 27)) return false }
  return bytes.length > 0
}

/**
 * Builds the pieces of an entry from its content: `{ local, central, nameBytes, ... }`. `options.level` 0 stores; otherwise the data
 * is deflated and kept so only if smaller.
 */
export async function makeEntry({ name, data, mtimeMs, mode, isDir = false, level = 6, atimeMs, uid = 0, gid = 0, noExtra = false }) {
  const nameBytes = encoder.encode(name)
  const unicode = nameBytes.length !== name.length
  let method = 0
  let body = data
  if (!isDir && level > 0 && data.length > 0) {
    const deflated = await deflateRaw(data)
    if (deflated.length < data.length) { method = 8; body = deflated }
  }
  const { time, date } = dosTime(mtimeMs)
  const crc = isDir ? 0 : crc32(data)
  const seconds = Math.floor(mtimeMs / 1000)
  const local = []
  const centralExtra = []
  const timeLocal = new Uint8Array(13)
  const lv = new DataView(timeLocal.buffer)
  lv.setUint16(0, 0x5455, true); lv.setUint16(2, 9, true); timeLocal[4] = 3; lv.setUint32(5, seconds, true); lv.setUint32(9, Math.floor((atimeMs ?? mtimeMs) / 1000), true)
  const timeCentral = new Uint8Array(9)
  const cv = new DataView(timeCentral.buffer)
  cv.setUint16(0, 0x5455, true); cv.setUint16(2, 5, true); timeCentral[4] = 3; cv.setUint32(5, seconds, true)
  const ux = new Uint8Array(15)
  const uv = new DataView(ux.buffer)
  uv.setUint16(0, 0x7875, true); uv.setUint16(2, 11, true); ux[4] = 1; ux[5] = 4; uv.setUint32(6, uid, true); ux[10] = 4; uv.setUint32(11, gid, true)
  const extraLocal = noExtra ? new Uint8Array() : joinChunks([timeLocal, ux])
  const extraCentral = noExtra ? new Uint8Array() : joinChunks([timeCentral, ux])
  void local; void centralExtra
  const versionNeeded = isDir || method === 8 ? 20 : 10
  const header = new Uint8Array(30 + nameBytes.length)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, 0x04034b50, true)
  hv.setUint16(4, versionNeeded, true)
  hv.setUint16(6, unicode ? 0x800 : 0, true)
  hv.setUint16(8, method, true)
  hv.setUint16(10, time, true)
  hv.setUint16(12, date, true)
  hv.setUint32(14, crc, true)
  hv.setUint32(18, body.length, true)
  hv.setUint32(22, isDir ? 0 : data.length, true)
  hv.setUint16(26, nameBytes.length, true)
  hv.setUint16(28, extraLocal.length, true)
  header.set(nameBytes, 30)
  return {
    name,
    method,
    crc,
    compressedSize: body.length,
    size: isDir ? 0 : data.length,
    mtimeMs,
    local: joinChunks([header, extraLocal, isDir ? new Uint8Array() : body]),
    central: { versionNeeded, flags: unicode ? 0x800 : 0, method, time, date, crc, nameBytes, extra: extraCentral, text: !isDir && isText(data), mode, isDir }
  }
}

/** A zip file from entries with `local` bytes and `central` descriptions (new from `makeEntry`, or read: `{ rawLocal, central }`) */
export function assemble(entries, comment = '') {
  const chunks = []
  const directory = []
  let offset = 0
  for (const entry of entries) {
    chunks.push(entry.local)
    const c = entry.central
    const record = new Uint8Array(46 + c.nameBytes.length + c.extra.length)
    const v = new DataView(record.buffer)
    v.setUint32(0, 0x02014b50, true)
    v.setUint16(4, c.versionMade ?? 0x031e, true)
    v.setUint16(6, c.versionNeeded, true)
    v.setUint16(8, c.flags, true)
    v.setUint16(10, c.method, true)
    v.setUint16(12, c.time, true)
    v.setUint16(14, c.date, true)
    v.setUint32(16, c.crc, true)
    v.setUint32(20, entry.compressedSize, true)
    v.setUint32(24, entry.size, true)
    v.setUint16(28, c.nameBytes.length, true)
    v.setUint16(30, c.extra.length, true)
    v.setUint16(32, 0, true)
    v.setUint16(34, 0, true)
    v.setUint16(36, c.text ? 1 : (c.internalAttr ?? 0), true)
    v.setUint32(38, c.externalAttr ?? (((c.mode & 0xffff) << 16) | (c.isDir ? 0x10 : 0)), true)
    v.setUint32(42, offset, true)
    record.set(c.nameBytes, 46)
    record.set(c.extra, 46 + c.nameBytes.length)
    directory.push(record)
    offset += entry.local.length
  }
  const central = joinChunks(directory)
  const commentBytes = encoder.encode(comment)
  const end = new Uint8Array(22 + commentBytes.length)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, central.length, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, commentBytes.length, true)
  end.set(commentBytes, 22)
  return joinChunks([...chunks, central, end])
}

/** The existing entries of a zip file as `assemble` takes them, so an archive can be added to without recompressing */
export function carry(bytes, parsed) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  return parsed.entries.map(entry => {
    const at = entry.offset
    let length = 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + entry.compressedSize
    if (entry.flags & 8) length += view.getUint32(at + length, true) === 0x08074b50 ? 16 : 12
    return {
      name: entry.name,
      method: entry.method,
      crc: entry.crc,
      compressedSize: entry.compressedSize,
      size: entry.size,
      mtimeMs: fromDos(entry.date, entry.time),
      local: bytes.slice(at, at + length),
      central: {
        versionMade: entry.versionMade, versionNeeded: entry.versionNeeded, flags: entry.flags, method: entry.method, time: entry.time, date: entry.date, crc: entry.crc,
        nameBytes: encoder.encode(entry.name), extra: entry.extra, internalAttr: entry.internalAttr, externalAttr: entry.externalAttr, isDir: entry.name.endsWith('/')
      }
    }
  })
}
