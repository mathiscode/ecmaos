/** Strip directory and suffix from file names, as GNU `basename` does: `basename NAME [SUFFIX]`, `-a` for several names, `-s SUFFIX`, `-z`. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`basename: ${text}\n`))

const usage = `Usage: basename NAME [SUFFIX]
  or:  basename OPTION... NAME...
Print NAME with any leading directory components removed. If specified, also remove a trailing SUFFIX.

  -a, --multiple       support multiple arguments and treat each as a NAME
  -s, --suffix=SUFFIX  remove a trailing SUFFIX; implies -a
  -z, --zero           end each output line with NUL, not newline
  --help               display this help and exit`

/** The last component of `name`, with the trailing slashes dropped; `/` for a name of only slashes, and empty for an empty name */
function base(name) {
  if (name === '') return ''
  const trimmed = name.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function main() {
  const args = argv.slice(1)
  let multiple = false
  let suffix
  let zero = false
  const names = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { names.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--multiple') { multiple = true; continue }
    if (arg === '--zero') { zero = true; continue }
    const long = /^--suffix(?:=(.*))?$/.exec(arg)
    if (long) { suffix = long[1] !== undefined ? long[1] : args[++i]; multiple = true; continue }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'basename --help' for more information."); return 1 }
    if (!arg.startsWith('-') || arg === '-') { names.push(arg); continue }
    for (let c = 1; c < arg.length; c++) {
      const flag = arg[c]
      if (flag === 'a') multiple = true
      else if (flag === 'z') zero = true
      else if (flag === 's') { suffix = c + 1 < arg.length ? arg.slice(c + 1) : args[++i]; multiple = true; break }
      else { err(`invalid option -- '${flag}'`); err("Try 'basename --help' for more information."); return 1 }
    }
  }

  if (names.length === 0) { err('missing operand'); err("Try 'basename --help' for more information."); return 1 }
  // Without -a or -s, a second name is the suffix
  if (!multiple) {
    if (names.length > 2) { err(`extra operand '${names[2]}'`); err("Try 'basename --help' for more information."); return 1 }
    if (names.length === 2) suffix = names.pop()
  }

  const end = zero ? '\0' : '\n'
  let out = ''
  for (const name of names) {
    let result = base(name)
    // A suffix is not removed when it is the whole name
    if (suffix && result !== suffix && result.endsWith(suffix) && result !== '/') result = result.slice(0, -suffix.length)
    out += result + end
  }
  writeAll(1, encoder.encode(out))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
