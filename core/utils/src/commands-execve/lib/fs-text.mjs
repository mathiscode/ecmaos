/** Small text-file helpers over the raw filesystem syscalls, shared by the pager commands. */

const { read, open, close, O_RDONLY } = globalThis.ecmaosSyscalls

const decoder = new TextDecoder()

/** Reads `fd` to EOF as text: a short read is not EOF (a pipe returns what it has), only `n <= 0` is. */
export function readFdText(fd) {
  const chunks = []
  const buffer = new Uint8Array(65536)
  while (true) {
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

/** The whole file at `path` as UTF-8 text. */
export function readTextFile(path) {
  const fd = open(path, O_RDONLY)
  try {
    return readFdText(fd)
  } finally {
    close(fd)
  }
}
