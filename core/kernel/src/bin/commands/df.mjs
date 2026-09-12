/**
 * Real `execve`'d `df` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/kernel/src/tree/lib/commands/index.ts`). `kernel.storage.usage()` has no direct worker-side
 * equivalent (it's a live `Kernel` method), so this reaches it through the `storage_usage` custom
 * syscall (`#lib/main-thread-syscalls.ts`), the same `custom`/`syscall_async` bridge `pilot-window.mjs`
 * proved out for `window_create`. The syscall itself formats nothing -- it hands back the raw
 * `StorageEstimate` as JSON, and this program does the human-readable formatting, exactly like the
 * original in-process version did.
 */

import humanFormat from 'human-format'

const { exit, write, custom, open, read, close, unlink } = globalThis.ecmaosSyscalls

function formatUsage(usage) {
  const data = {}
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'object' && value !== null) data[key] = formatUsage(value)
    else if (typeof value === 'number') data[key] = humanFormat(value)
    else data[key] = String(value)
  }
  return data
}

/** `kernel.storage.usage()` (a live `Kernel` method) is reached through `storage_usage`, the same
 * `custom`/`syscall_async` bridge `pilot-window.mjs` proved for `window_create`; the syscall itself
 * can only return a `number` (`dispatch`'s contract), so it writes its JSON result into this real
 * scratch file instead, and this program reads it back with the plain filesystem syscalls it
 * already has -- exactly how a real `/proc`-reading `df` gets its numbers as text, not a live struct. */
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
  const path = `/tmp/.df-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await custom('storage_usage', path)
  const raw = await readBackAndDelete(path)
  const usage = JSON.parse(raw)
  const data = formatUsage(usage)
  write(1, new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n'))
  return 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`df: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
