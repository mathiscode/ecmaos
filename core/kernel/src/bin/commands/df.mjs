/** Report filesystem storage usage. */

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
