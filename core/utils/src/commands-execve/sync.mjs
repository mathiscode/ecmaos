/**
 * `sync`: write out what the filesystems hold. With FILEs, each is flushed (`fsync`, or with `-d` `fdatasync`), or
 * with `-f` the filesystem each is on. The IndexedDB root commits every write as it is made, so there is rarely anything
 * left for this to do; a backend that buffers is told to write.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'

const { argv, exit, writeAll, open, close, custom, O_RDONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`sync: ${text}\n`))

const usage = `Usage: sync [OPTION] [FILE]...
Synchronize cached writes to persistent storage

If one or more files are specified, sync only them,
or their containing file systems.

  -d, --data             sync only file data, no unneeded metadata
  -f, --file-system      sync the file systems that contain the files
      --help        display this help and exit
      --version     output version information and exit`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'df', long: { data: 'd', 'file-system': 'f', help: 'help', version: 'version' } })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('sync') + '\n')); return 1 }
  let data = false
  let fileSystem = false
  for (const [key] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeAll(1, encoder.encode('sync (ecmaOS coreutils) 1.0\n')); return 0 }
    if (key === 'd') data = true
    else if (key === 'f') fileSystem = true
  }
  if (data && fileSystem) { err('cannot specify both --data and --file-system'); return 1 }
  if (data && operands.length === 0) { err('--data needs at least one argument'); return 1 }
  if (operands.length === 0 || fileSystem) {
    for (const file of operands) {
      try { close(open(file, O_RDONLY)) } catch (e) { err(`error opening ${quotef(file)}: ${reasonOf(e)}`); return 1 }
    }
    await custom('sync_all')
    return 0
  }
  let status = 0
  for (const file of operands) {
    let fd
    try { fd = open(file, O_RDONLY) } catch (e) { err(`error opening ${quotef(file)}: ${reasonOf(e)}`); status = 1; continue }
    try { await custom(data ? 'fdatasync' : 'fsync', fd) } catch (e) { err(`error syncing ${quotef(file)}: ${reasonOf(e)}`); status = 1 } finally { close(fd) }
  }
  return status
}

try {
  exit(await main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
