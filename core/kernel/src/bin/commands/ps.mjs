/**
 * Real `execve`'d `ps` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/kernel/src/tree/lib/commands/index.ts`). `kernel.processes.all` is a live, main-thread-only
 * process table, so this reaches it through the `ps_list` custom syscall (`#lib/main-thread-syscalls.ts`),
 * the same pattern `df.mjs` uses for `storage_usage`. No ANSI colour here (the original used `chalk`
 * for a TTY-only presentation) -- kept plain to match every other migrated coreutil's stdout-is-just-
 * text convention; a real terminal can still colour it downstream if that's ever wanted back.
 */

const { exit, write, custom, open, read, close, unlink } = globalThis.ecmaosSyscalls

/** See `df.mjs`'s `readBackAndDelete` doc comment -- same scratch-file bridge, for `ps_list`. */
async function readBackAndDelete(path) {
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

async function main() {
  const path = `/tmp/.ps-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await custom('ps_list', path)
  const raw = await readBackAndDelete(path)
  const list = JSON.parse(raw)
  const lines = ['PID\tCOMMAND\t\t\tSTATUS']
  for (const { pid, command, status } of list) lines.push(`${pid}\t${command}\t\t\t${status}`)
  write(1, new TextEncoder().encode(lines.join('\n') + '\n'))
  return 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`ps: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
