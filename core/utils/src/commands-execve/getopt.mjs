/**
 * `getopt`: parse a command line in a shell script, as util-linux's enhanced `getopt` does. It prints the options it found
 * in a normal order, each with its argument quoted, then `--` and the operands: `eval set -- "$(getopt -o ab: -l all,out: -- "$@")"`.
 * Short options come from `-o` (or the first operand, in the old form); `-l` gives long ones, `:` after a name meaning an
 * argument is required and `::` an optional one that must be attached.
 */

import { getopt as parse } from './lib/getopt.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))

const usage = `
Usage:
 getopt <optstring> <parameters>
 getopt [options] [--] <optstring> <parameters>
 getopt [options] -o|--options <optstring> [options] [--] <parameters>

Parse command options.

Options:
 -a, --alternative             allow long options starting with single -
 -l, --longoptions <longopts>  the long options to be recognized
 -n, --name <progname>         the name under which errors are reported
 -o, --options <optstring>     the short options to be recognized
 -q, --quiet                   disable error reporting by getopt(3)
 -Q, --quiet-output            no normal output
 -s, --shell <shell>           set quoting conventions to those of <shell>
 -T, --test                    test for getopt(1) version
 -u, --unquoted                do not quote the output

 -h, --help                    display this help
 -V, --version                 display version`

const quote = text => `'${text.replaceAll("'", "'\\''")}'`

async function main() {
  const args = argv.slice(1)
  let shortSpec
  let longSpec = ''
  let name = 'getopt'
  let quiet = false
  let quietOutput = false
  let unquoted = false
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const takes = (long, short) => {
      if (arg === long || arg === short) return args[++i]
      if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1)
      if (short.length === 2 && arg.startsWith(short) && arg.length > 2 && !arg.startsWith('--')) return arg.slice(2)
      return undefined
    }
    if (arg === '--') { rest.push(...args.slice(i + 1)); break }
    if (arg === '-T' || arg === '--test') return 4
    if (arg === '-h' || arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '-V' || arg === '--version') { out('getopt from ecmaOS coreutils 1.0\n'); return 0 }
    if (arg === '-q' || arg === '--quiet') { quiet = true; continue }
    if (arg === '-Q' || arg === '--quiet-output') { quietOutput = true; continue }
    if (arg === '-u' || arg === '--unquoted') { unquoted = true; continue }
    if (arg === '-a' || arg === '--alternative') continue
    let value
    if ((value = takes('--options', '-o')) !== undefined) { shortSpec = value; continue }
    if ((value = takes('--longoptions', '-l')) !== undefined) { longSpec += (longSpec ? ',' : '') + value; continue }
    if ((value = takes('--name', '-n')) !== undefined) { name = value; continue }
    if ((value = takes('--shell', '-s')) !== undefined) { if (!['sh', 'bash', 'csh', 'tcsh'].includes(value)) { writeAll(2, encoder.encode('getopt: unknown shell after -s or --shell argument\n')); return 2 } continue }
    if (arg.startsWith('-') && arg.length > 1 && shortSpec === undefined) {
      writeAll(2, encoder.encode(`getopt: invalid option -- '${arg.replace(/^-+/, '')}'\nTry 'getopt --help' for more information.\n`))
      return 2
    }
    rest.push(...args.slice(i))
    break
  }

  // the old form: no -o, so the first operand is the option string
  if (shortSpec === undefined) {
    if (!rest.length) { writeAll(2, encoder.encode('getopt: missing optstring argument\nTry \'getopt --help\' for more information.\n')); return 2 }
    shortSpec = rest.shift()
  }

  let permute = true
  if (shortSpec.startsWith('+') || env.POSIXLY_CORRECT !== undefined) permute = false
  shortSpec = shortSpec.replace(/^[+-]/, '')

  const long = {}
  const kinds = new Map()
  for (const entry of longSpec.split(',').filter(Boolean)) {
    const match = /^([^:]+)(::?)?$/.exec(entry)
    if (!match) continue
    const arg = match[2] === '::' ? 'optional' : match[2] === ':' ? 'required' : 'none'
    long[match[1]] = { key: `--${match[1]}`, arg }
    kinds.set(`--${match[1]}`, arg)
  }
  for (let i = 0; i < shortSpec.length; i++) {
    if (shortSpec[i] === ':') continue
    kinds.set(shortSpec[i], shortSpec[i + 1] === ':' ? (shortSpec[i + 2] === ':' ? 'optional' : 'required') : 'none')
  }

  const result = parse(rest, { short: shortSpec, long, permute })
  const pieces = []
  const value = text => unquoted ? text : quote(text)
  for (const [key, argument] of result.options) {
    pieces.push(key.startsWith('--') ? key : `-${key}`)
    if (kinds.get(key) !== 'none') pieces.push(value(argument === true ? '' : argument))
  }
  let status = 0
  if (result.error) {
    status = 1
    if (!quiet) writeAll(2, encoder.encode(`${name}: ${result.error}\n`))
  }
  pieces.push('--', ...result.operands.map(value))
  if (!quietOutput) out(' ' + pieces.join(' ') + '\n')
  return status
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, encoder.encode(`getopt: ${error?.message ?? String(error)}\n`))
  exit(3)
}
