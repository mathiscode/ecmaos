/** Check whether a directory or file is a mountpoint, by looking for it in `/proc/mounts`. */

import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { canonical, readMounts } from './lib/mounts.mjs'

const { argv, exit, writeAll, stat } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`mountpoint: ${text}\n`))

const usage = `Usage:
 mountpoint [-qd] /path/to/directory
 mountpoint -x /dev/device

Check whether a directory or file is a mountpoint.

Options:
 -q, --quiet        quiet mode - don't print anything
     --nofollow     do not follow symlink
     --show         print mountpoint for given path
 -h, --help         display this help
 -V, --version      display version

A filesystem here has no device number, so -d and -x are refused.`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'qdxhV', long: { quiet: 'q', nofollow: 'nofollow', show: 'show', 'fs-devno': 'd', devno: 'x', help: 'h', version: 'V' } })
  if (error) { err(error); return 1 }
  let quiet = false
  let follow = true
  let show = false
  for (const [key] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'V') { out('mountpoint (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'd' || key === 'x') { err('device numbers are not available: a mounted filesystem here has none'); return 1 }
    if (key === 'q') quiet = true
    else if (key === 'nofollow') follow = false
    else if (key === 'show') show = true
  }
  if (operands.length !== 1) { err(operands.length ? 'too many arguments' : 'no directory specified'); return 1 }
  const name = operands[0]
  try { stat(name) } catch (e) { if (!quiet) err(`${name}: ${reasonOf(e)}`); return 32 }
  let path
  try { path = canonical(name, follow) } catch (e) { if (!quiet) err(`${name}: ${reasonOf(e)}`); return 32 }
  const mounted = readMounts().some(mount => mount.target === path)
  if (show) { if (mounted) out(path + '\n'); return mounted ? 0 : 1 }
  if (!quiet) out(mounted ? `${name} is a mountpoint\n` : `${name} is not a mountpoint\n`)
  return mounted ? 0 : 1
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
