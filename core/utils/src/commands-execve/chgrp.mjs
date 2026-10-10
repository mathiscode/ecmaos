/**
 * Change the group of files: `chgrp staff file`, `chgrp -R 100 dir`.
 *
 * The group is a name from `/etc/group` or a number. The owner is left as it is. As with `chown -R`, changing
 * a directory's ownership from a program needs a newer `@zenfs/core` than the published one; elsewhere it is
 * reported per file and the rest carry on.
 */

import { readTextFile } from './lib/fs-text.mjs'
import { join, resolve } from './lib/path-utils.mjs'

import { chownOwned } from './lib/owner-ops.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, lstat, stat, readdir } = sys

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`chgrp: ${text}\n`))
const S_IFMT = 0xf000
const S_IFDIR = 0x4000

const usage = `Usage: chgrp [OPTION]... GROUP FILE...
   or:  chgrp [OPTION]... --reference=RFILE FILE...
Change the group of each FILE to GROUP (a name from /etc/group, or a number).

  -R, --recursive       operate on files and directories recursively
  -v, --verbose         say what is done for every file
  -c, --changes         like -v, but only when a change is made
  -f, --silent, --quiet suppress most error messages
  --reference=RFILE     use RFILE's group instead of naming one
  --help                display this help and exit`

function groupId(spec) {
  if (/^\d+$/.test(spec)) return Number(spec)
  let text = ''
  try { text = readTextFile('/etc/group') } catch { /* none */ }
  for (const line of text.split('\n')) {
    const [name, , gid] = line.split(':')
    if (name === spec && gid !== undefined) return Number(gid)
  }
  return undefined
}

async function main() {
  const args = argv.slice(1)
  const o = { recursive: false, verbose: false, changes: false, quiet: false, reference: undefined }
  const rest = []
  for (const arg of args) {
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--recursive') o.recursive = true
    else if (arg === '--verbose') o.verbose = true
    else if (arg === '--changes') o.changes = true
    else if (arg === '--silent' || arg === '--quiet') o.quiet = true
    else if (arg.startsWith('--reference=')) o.reference = arg.slice(12)
    else if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); return 1 }
    else if (/^-[RvcfH]+$/.test(arg)) { for (const letter of arg.slice(1)) { if (letter === 'R') o.recursive = true; else if (letter === 'v') o.verbose = true; else if (letter === 'c') o.changes = true; else if (letter === 'f') o.quiet = true } }
    else rest.push(arg)
  }
  const cwd = getcwd()
  let gid
  let files
  if (o.reference !== undefined) {
    try { gid = stat(resolve(cwd, o.reference)).gid } catch (error) { err(`failed to get attributes of '${o.reference}': ${error?.message ?? error}`); return 1 }
    files = rest
  } else {
    if (rest.length < 2) { err(rest.length === 0 ? 'missing operand' : `missing operand after '${rest[0]}'`); return 1 }
    gid = groupId(rest[0])
    if (gid === undefined) { err(`invalid group: '${rest[0]}'`); return 1 }
    files = rest.slice(1)
  }
  if (files.length === 0) { err('missing operand'); return 1 }

  let failed = false
  const apply = async (shown, full) => {
    let info
    try { info = lstat(full) } catch (error) { if (!o.quiet) err(`cannot access '${shown}': ${error?.message ?? error}`); failed = true; return }
    const changed = info.gid !== gid
    try {
      if (changed) await chownOwned(sys, full, info.uid, gid)
      if (o.verbose || (o.changes && changed)) writeAll(1, encoder.encode(changed ? `changed group of '${shown}' to ${gid}\n` : `group of '${shown}' retained as ${gid}\n`))
    } catch (error) { if (!o.quiet) err(`changing group of '${shown}': ${error?.message ?? error}`); failed = true }
    if (o.recursive && (info.mode & S_IFMT) === S_IFDIR) {
      for (const name of readdir(full).filter(entry => entry !== '.' && entry !== '..').sort()) await apply(`${shown.replace(/\/+$/, '')}/${name}`, join(full, name))
    }
  }
  for (const file of files) await apply(file, resolve(cwd, file))
  return failed ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
