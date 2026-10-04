/** Reading and writing whole files as bytes, for the programs that treat their input as a blob. */

const { open, close, read, write, stat, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

/** Everything readable from `fd`, to end of file. */
export function readFdBytes(fd) {
  const chunks = []
  let total = 0
  for (;;) {
    const buffer = new Uint8Array(65536)
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    total += n
  }
  return joinChunks(chunks, total)
}

export function joinChunks(chunks, total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)) {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

/** The whole of a file. */
export function readFileBytes(path) {
  const fd = open(path, O_RDONLY, 0)
  try { return readFdBytes(fd) } finally { close(fd) }
}

/** `bytes` written in full to `fd`; a pipe may take less than asked, so this goes on until it has all gone. */
export function writeFdBytes(fd, bytes) {
  let offset = 0
  while (offset < bytes.length) offset += write(fd, bytes.subarray(offset), -1)
}

/** `bytes` as the whole content of `path`, created with `mode` when new. */
export function writeFileBytes(path, bytes, mode = 0o644) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode)
  try { writeFdBytes(fd, bytes) } finally { close(fd) }
}

export const sizeOf = path => stat(path).size
