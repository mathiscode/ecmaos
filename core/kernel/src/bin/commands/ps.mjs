/** List running processes. Plain text output, no ANSI coloring. */

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
