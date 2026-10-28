/**
 * `pathchk`: check that file names are valid and portable. Without options, a name is checked against this system:
 * each component at most 255 bytes, the whole at most 4095, and each directory on the way searchable. `-p` checks
 * against POSIX's portable limits and characters (`A-Za-z0-9._-`, 14-byte components, 256-byte names), `-P` for empty
 * names and components that start with `-`.
 */

const { argv, exit, writeAll, stat } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`pathchk: ${text}\n`))

const usage = `Usage: pathchk [OPTION]... NAME...
Diagnose invalid or non-portable file names.

  -p                  check for most POSIX systems
  -P                  check for empty names and leading "-"
      --portability   check for all POSIX systems (equivalent to -p -P)
      --help        display this help and exit
      --version     output version information and exit`

function check(name, posix, extra) {
  const bytes = encoder.encode(name).length
  if (extra && name === '') return 'empty file name'
  const parts = name.split('/').filter(Boolean)
  if (extra) {
    const dash = parts.find(part => part.startsWith('-'))
    if (dash) return `leading '-' in a component of file name '${name}'`
  }
  if (posix) {
    const bad = [...name].find(c => !/[A-Za-z0-9._\/-]/.test(c))
    if (bad) return `nonportable character '${bad}' in file name '${name}'`
    if (bytes > 255) return `limit 256 exceeded by length ${bytes + 1} of file name '${name}'`
    const long = parts.find(part => encoder.encode(part).length > 14)
    if (long) return `limit 14 exceeded by length ${encoder.encode(long).length} of file name component '${long}'`
    return undefined
  }
  if (bytes > 4095) return `limit 4096 exceeded by length ${bytes + 1} of file name '${name}'`
  const long = parts.find(part => encoder.encode(part).length > 255)
  if (long) return `limit 255 exceeded by length ${encoder.encode(long).length} of file name component '${long}'`
  // every directory that exists on the way must be one
  let path = name.startsWith('/') ? '' : '.'
  for (const part of parts.slice(0, -1)) {
    path += '/' + part
    try { if ((stat(path).mode & 0o170000) !== 0o040000) return `'${path.replace(/^\.\//, '')}': Not a directory` } catch { break }
  }
  return undefined
}

function main() {
  let posix = false, extra = false
  const names = []
  let ended = false
  for (const arg of argv.slice(1)) {
    if (!ended && arg === '--') { ended = true; continue }
    if (!ended && arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (!ended && arg === '--version') { writeAll(1, encoder.encode('pathchk (ecmaOS coreutils) 1.0\n')); return 0 }
    if (!ended && arg === '--portability') { posix = extra = true; continue }
    if (!ended && /^-[pP]+$/.test(arg)) { if (arg.includes('p')) posix = true; if (arg.includes('P')) extra = true; continue }
    if (!ended && arg.startsWith('-') && arg !== '-') { err(`invalid option -- '${arg[1]}'`); writeAll(2, encoder.encode("Try 'pathchk --help' for more information.\n")); return 1 }
    names.push(arg)
  }
  if (names.length === 0) { err('missing operand'); writeAll(2, encoder.encode("Try 'pathchk --help' for more information.\n")); return 1 }
  let status = 0
  for (const name of names) {
    const problem = check(name, posix, extra)
    if (problem) { err(problem); status = 1 }
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
