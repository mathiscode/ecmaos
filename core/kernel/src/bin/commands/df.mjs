/**
 * Real `execve`'d `df` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/kernel/src/tree/lib/commands/index.ts`). `kernel.storage.usage()` has no direct worker-side
 * equivalent (it's a live `Kernel` method), so this reaches it through the `storage_usage` custom
 * syscall (`#lib/main-thread-syscalls.ts`), the same `custom`/`syscall_async` bridge `pilot-window.mjs`
 * proved out for `window_create`. The syscall itself formats nothing -- it hands back the raw
 * `StorageEstimate` as JSON, and this program does the human-readable formatting, exactly like the
 * original in-process version did. `readBackAndDelete`/`scratchPath` are `lib/scratch.mjs`'s shared
 * scratch-file bridge, the same one `ps.mjs`/`sockets.mjs` use.
 */

import humanFormat from 'human-format'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { exit, write, custom } = syscalls

function formatUsage(usage) {
  const data = {}
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'object' && value !== null) data[key] = formatUsage(value)
    else if (typeof value === 'number') data[key] = humanFormat(value)
    else data[key] = String(value)
  }
  return data
}

async function main() {
  const path = scratchPath('df')
  await custom('storage_usage', path)
  const raw = await readBackAndDelete(syscalls, path)
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
