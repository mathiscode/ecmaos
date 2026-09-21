/**
 * The read-back half of the scratch-file bridge every kernel-native custom syscall that needs to
 * return more than a plain `number | bigint | void` uses (`storage_usage`/`ps_list`/`sockets_*`,
 * see `#lib/main-thread-syscalls.ts`'s own doc comment on why a custom syscall can't just return a
 * string): the main-thread handler writes its JSON result into a real file under `/tmp`, and this
 * reads it back with the plain filesystem syscalls a worker-hosted program already has, then
 * deletes it -- no custom syscall needed on the read side at all.
 *
 * Extracted here once three call sites (`df.mjs`, `ps.mjs`, `sockets.mjs`) needed the identical
 * function; was duplicated verbatim in the first two before that.
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
 * same or another command -- the same shape `df.mjs`/`ps.mjs` each hand-rolled inline before. */
export function scratchPath(prefix) {
  return `/tmp/.${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
