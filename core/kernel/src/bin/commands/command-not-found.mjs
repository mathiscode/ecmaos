/**
 * Says what could be installed to get a command the system does not have, as Debian's does: the shells call it after
 * `NAME: command not found`. It reads the package index (no network), prints on standard error and ends with 127, which
 * is the status of the command that was not found. It never installs anything.
 */
import { scopeOf } from './lib/install/db.mjs'
import { hintFor } from './lib/install/hint.mjs'
import { loadIndex } from './lib/install/names.mjs'

const { argv, exit, write, geteuid } = globalThis.ecmaosSyscalls

if (argv.slice(1).some(arg => arg === '--help' || arg === '-h')) {
  write(2, new TextEncoder().encode('Usage: command-not-found COMMAND...\nSay which package provides a command that is not installed.\n'))
  exit(0)
} else {
  const { index } = loadIndex(scopeOf())
  const root = geteuid() === 0
  for (const name of argv.slice(1)) {
    const hint = hintFor(index, name, { root })
    if (hint) write(2, new TextEncoder().encode(hint + '\n'))
  }
  exit(127)
}
