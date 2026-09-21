/**
 * Real `execve`'d `ps` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/kernel/src/tree/lib/commands/index.ts`). `kernel.processes.all` is a live, main-thread-only
 * process table, so this reaches it through the `ps_list` custom syscall (`#lib/main-thread-syscalls.ts`),
 * the same pattern `df.mjs` uses for `storage_usage`, including `lib/scratch.mjs`'s shared scratch-
 * file bridge. No ANSI colour here (the original used `chalk` for a TTY-only presentation) -- kept
 * plain to match every other migrated coreutil's stdout-is-just-text convention; a real terminal can
 * still colour it downstream if that's ever wanted back.
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { exit, write, custom } = syscalls

async function main() {
  const path = scratchPath('ps')
  await custom('ps_list', path)
  const raw = await readBackAndDelete(syscalls, path)
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
