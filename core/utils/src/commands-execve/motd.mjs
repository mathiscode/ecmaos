/** Print the message of the day. */

import { readFileBytes } from './lib/bytes.mjs'

const { argv, exit, writeAll, open, read, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: motd
Print the message of the day (/etc/motd), if one exists.

  --help  display this help and exit`

function readWholeFile(fullPath) {
  const bytes = readFileBytes(fullPath)
  return bytes
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(1, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let motd
  try {
    motd = readWholeFile('/etc/motd')
  } catch {
    return 0
  }

  if (motd.length > 0) writeAll(1, motd)
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`motd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
