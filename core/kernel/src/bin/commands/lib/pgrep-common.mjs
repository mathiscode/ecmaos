/**
 * `pgrep` and `pkill`: select processes by name (or full command line) and either list them or signal them.
 * They read the process table from `/proc`, as `ps` and `killall` do.
 */

import { listProcesses, readText } from './proc.mjs'
import { SignalNumbers, parseSignalArg } from './signals.mjs'

const { argv, exit, write, custom, getpid, getppid } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()

const usage = kind => `Usage: ${kind} [OPTION]... PATTERN
${kind === 'pgrep' ? 'List the process IDs of processes whose name matches PATTERN.' : 'Send a signal (SIGTERM by default) to processes whose name matches PATTERN.'}

  -f, --full          match PATTERN against the whole command line, not just the name
  -x, --exact         the whole name (or command line) must match PATTERN
  -i, --ignore-case   match without regard to case
  -v, --inverse       select the processes that do NOT match
  -u, --euid USER     only processes of USER (a name or a number)
  -P, --parent PPID   only children of PPID
  -n, --newest        only the newest match
  -o, --oldest        only the oldest match
${kind === 'pgrep' ? `  -l, --list-name     also print each process's name
  -a, --list-full     also print each process's full command line
  -c, --count         print only how many matched
  -d, --delimiter STR separate the IDs with STR instead of a newline
` : `  -SIGNAL, --signal SIGNAL  the signal to send, by name or number
  -e, --echo          print each process that is signalled
  -c, --count         print only how many matched
`}  --help             display this help and exit

PATTERN is a regular expression. The status is 0 when something matched, 1 when nothing did, 2 for a bad option.`

/** `/etc/passwd` user names to ids. */
function userId(spec) {
  if (/^\d+$/.test(spec)) return Number(spec)
  for (const line of readText('/etc/passwd').split('\n')) {
    const [name, , uid] = line.split(':')
    if (name === spec) return Number(uid)
  }
  return undefined
}

export async function main(kind) {
  const fail = message => { write(2, encoder.encode(`${kind}: ${message}\n`)); return 2 }
  const args = argv.slice(1)
  const o = { full: false, exact: false, ignoreCase: false, inverse: false, uid: undefined, parent: undefined, newest: false, oldest: false, list: false, listFull: false, count: false, delimiter: '\n', echo: false, signal: SignalNumbers.TERM }
  let pattern
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { write(1, encoder.encode(usage(kind) + '\n')); return 0 }
    if (arg === '--') { pattern = args[i + 1]; break }
    // `pkill -9` and `pkill -HUP`: a number, or a name in capitals, is a signal; lower-case letters are flags
    if (kind === 'pkill' && /^-(\d+|(SIG)?[A-Z][A-Z0-9]+)$/.test(arg)) {
      const parsed = parseSignalArg(arg)
      if (parsed === undefined) return fail(`${arg}: unknown signal`)
      if (parsed !== null) { o.signal = parsed; continue }
    }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=')
      const take = () => inline ?? args[++i]
      switch (name) {
        case 'full': o.full = true; break
        case 'exact': o.exact = true; break
        case 'ignore-case': o.ignoreCase = true; break
        case 'inverse': o.inverse = true; break
        case 'newest': o.newest = true; break
        case 'oldest': o.oldest = true; break
        case 'count': o.count = true; break
        case 'list-name': o.list = true; break
        case 'list-full': o.listFull = true; break
        case 'echo': o.echo = true; break
        case 'euid': case 'uid': { const id = userId(take() ?? ''); if (id === undefined) return fail('invalid user name'); o.uid = id; break }
        case 'parent': o.parent = Number(take()); break
        case 'delimiter': o.delimiter = take() ?? '\n'; break
        case 'signal': { const text = take() ?? ''; const parsed = parseSignalArg('-' + text); if (!parsed && parsed !== 0) return fail(`${text}: unknown signal`); o.signal = parsed; break }
        default: return fail(`unrecognized option '${arg}'`)
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]
        const rest = arg.slice(j + 1)
        const take = () => rest !== '' ? rest : args[++i]
        if (letter === 'f') o.full = true
        else if (letter === 'x') o.exact = true
        else if (letter === 'i') o.ignoreCase = true
        else if (letter === 'v') o.inverse = true
        else if (letter === 'n') o.newest = true
        else if (letter === 'o') o.oldest = true
        else if (letter === 'c') o.count = true
        else if (letter === 'l') o.list = true
        else if (letter === 'a') o.listFull = true
        else if (letter === 'e') o.echo = true
        else if (letter === 'u') { const id = userId(take() ?? ''); if (id === undefined) return fail('invalid user name'); o.uid = id; break }
        else if (letter === 'P') { o.parent = Number(take()); break }
        else if (letter === 'd') { o.delimiter = take() ?? '\n'; break }
        else return fail(`invalid option -- '${letter}'`)
      }
      continue
    }
    pattern = arg
    break
  }
  if (pattern === undefined) return fail('no matching criteria specified')
  let regex
  try {
    regex = new RegExp(o.exact ? `^(?:${pattern})$` : pattern, o.ignoreCase ? 'i' : '')
  } catch { return fail(`invalid pattern: ${pattern}`) }

  const self = getpid()
  const parent = getppid()
  let found = []
  for (const proc of listProcesses()) {
    if (proc.pid === self || proc.pid === parent) continue
    if (o.uid !== undefined && proc.uid !== o.uid) continue
    if (o.parent !== undefined && proc.ppid !== o.parent) continue
    let subject = proc.command
    let cmdline = proc.command
    try { cmdline = readText(`/proc/${proc.pid}/cmdline`).split('\0').filter(Boolean).join(' ') || proc.command } catch { /* gone */ }
    if (o.full) subject = cmdline
    if (proc.command.startsWith('[')) continue
    if (regex.test(subject) === o.inverse) continue
    found.push({ ...proc, cmdline })
  }
  if (o.newest && found.length) found = [found[found.length - 1]]
  else if (o.oldest && found.length) found = [found[0]]
  if (found.length === 0) { if (o.count) write(1, encoder.encode('0\n')); return 1 }

  if (kind === 'pgrep') {
    if (o.count) { write(1, encoder.encode(found.length + '\n')); return 0 }
    const lines = found.map(p => o.listFull ? `${p.pid} ${p.cmdline}` : o.list ? `${p.pid} ${p.command}` : String(p.pid))
    write(1, encoder.encode(lines.join(o.delimiter) + '\n'))
    return 0
  }
  let signalled = 0
  let status = 0
  for (const proc of found) {
    try {
      await custom('proc_kill', proc.pid, o.signal)
      signalled++
      if (o.echo) write(1, encoder.encode(`${proc.command} killed (pid ${proc.pid})\n`))
    } catch (error) {
      status = 1
      write(2, encoder.encode(`pkill: killing pid ${proc.pid} failed: ${error instanceof Error ? error.message : String(error)}\n`))
    }
  }
  if (o.count) write(1, encoder.encode(signalled + '\n'))
  return signalled > 0 ? status : 1
}

export async function start(kind) {
  try { exit(await main(kind)) } catch (error) {
    write(2, encoder.encode(`${kind}: ${error instanceof Error ? error.message : String(error)}\n`))
    exit(2)
  }
}
