/**
 * Reads back and deletes the scratch file a main-thread custom syscall wrote its JSON result to (a syscall can only
 * return a number); see `#lib/main-thread-syscalls.ts`.
 */
export async function readBackAndDelete({ open, read, close, unlink }, path) {
  const fd = open(path, 0)
  const chunkSize = 65536
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      if (n < chunkSize) break
    }
  } finally {
    close(fd)
    unlink(path)
  }
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])))
}

/** A scratch path under `/tmp` unique enough to not collide with a concurrent invocation of the
 * same or another command - the same shape `df.mjs`/`ps.mjs` each hand-rolled inline before. */
export function scratchPath(prefix) {
  return `/tmp/.${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
