/** Look entries up in the account databases: `getent passwd root`, `getent group`. */

import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`getent: ${text}\n`))

const usage = `Usage: getent DATABASE [KEY]...
Print the entries of DATABASE (passwd or group) that match each KEY (a name or a number), or all of them.

  --help  display this help and exit

The status is 0 when everything asked for was found, 1 for a bad command line, 2 when a key was not found
and 3 when the database cannot be listed.`

const FILES = { passwd: '/etc/passwd', group: '/etc/group' }

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
  if (args.length === 0) { err('Wrong number of arguments\n' + usage); return 1 }
  const database = args[0]
  const file = FILES[database]
  if (!file) { err(`Unknown database: ${database}`); return 1 }
  let lines
  try { lines = readTextFile(file).split('\n').filter(line => line.trim() && !line.startsWith('#')) } catch { return 3 }
  const keys = args.slice(1)
  if (keys.length === 0) { if (lines.length) writeAll(1, encoder.encode(lines.join('\n') + '\n')); return 0 }
  let status = 0
  const out = []
  for (const key of keys) {
    const found = lines.find(line => { const [name, , id] = line.split(':'); return name === key || id === key })
    if (found) out.push(found)
    else status = 2
  }
  if (out.length) writeAll(1, encoder.encode(out.join('\n') + '\n'))
  return status
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
