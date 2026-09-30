/** List running processes, read from `/proc`. Plain text output, no ANSI coloring. */

import { listProcesses } from './lib/proc.mjs'

const { exit, write } = globalThis.ecmaosSyscalls

function main() {
  const lines = ['PID\tPPID\tUID\tCOMMAND']
  for (const { pid, ppid, uid, command } of listProcesses()) lines.push(`${pid}\t${ppid}\t${uid}\t${command}`)
  write(1, new TextEncoder().encode(lines.join('\n') + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`ps: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
