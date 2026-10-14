/** Strip the last component from file names, as GNU `dirname` does: trailing slashes are dropped, a name with no slash gives `.`, and `-z` ends lines with NUL. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`dirname: ${text}\n`))

const usage = `Usage: dirname [OPTION] NAME...
Output each NAME with its last non-slash component and trailing slashes removed; if NAME contains no /'s, output '.'.

  -z, --zero   end each output line with NUL, not newline
  --help       display this help and exit`

function dirname(name) {
  if (name === '') return '.'
  // The last component and the slashes before and after it are removed
  const trimmed = name.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const slash = trimmed.lastIndexOf('/')
  if (slash < 0) return '.'
  const parent = trimmed.slice(0, slash).replace(/\/+$/, '')
  return parent === '' ? '/' : parent
}

function main() {
  const args = argv.slice(1)
  let zero = false
  const names = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { names.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-z' || arg === '--zero') zero = true
    else if (arg.startsWith('-') && arg !== '-') { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); err("Try 'dirname --help' for more information."); return 1 }
    else names.push(arg)
  }
  if (names.length === 0) { err('missing operand'); err("Try 'dirname --help' for more information."); return 1 }
  writeAll(1, encoder.encode(names.map(dirname).join(zero ? '\0' : '\n') + (zero ? '\0' : '\n')))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
