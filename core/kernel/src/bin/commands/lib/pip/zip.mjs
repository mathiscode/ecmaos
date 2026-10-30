/** A ZIP reader, enough for wheels: the central directory, stored and deflated entries, CRC-32 checked. */

const decoder = new TextDecoder()

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** The entries of a zip file: `[{ name, method, compressed, size, crc, offset, mode, directory }]` */
export function entriesOf(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error('not a zip file')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 archives are not supported')
  const entries = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('corrupt zip directory')
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    const attributes = view.getUint32(at + 38, true)
    entries.push({
      name,
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
      // the Unix mode is the top half of the external attributes
      mode: (attributes >>> 16) & 0o7777,
      directory: name.endsWith('/')
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The bytes of one entry, inflated and checked */
export async function read(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const raw = bytes.subarray(start, start + entry.compressed)
  let data
  if (entry.method === 0) data = raw
  else if (entry.method === 8) {
    const source = new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close() } })
    data = new Uint8Array(await new Response(source.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
  }
  else throw new Error(`${entry.name}: unsupported compression method ${entry.method}`)
  if (data.length !== entry.size) throw new Error(`${entry.name}: wrong size`)
  if (crc32(data) !== entry.crc) throw new Error(`${entry.name}: bad CRC-32`)
  return data
}
