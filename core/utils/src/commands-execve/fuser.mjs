/**
 * `fuser`: which processes use a file, or (with `-m`) the filesystem it is on, from what `/proc/<pid>` links to:
 * each open descriptor (`f`), the working directory (`c`), the root (`r`) and the program (`e`). The names go to
 * standard error and the pids to standard output, as psmisc's fuser writes them; `-v` shows a table, `-k` signals the
 * processes. There are no network sockets to look up (`-n tcp`, `udp`).
 */

import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { openFiles, processes, userNames } from './lib/procs.mjs'
import { canonical, mountFor, readMounts } from './lib/mounts.mjs'

const { argv, exit, writeAll, stat, getpid, custom, read } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const say = text => writeAll(2, encoder.encode(text))

const usage = `Usage: fuser [-fIMuvw] [-a|-s] [-4|-6] [-c|-m|-n SPACE]
             [-k [-i] [-SIGNAL]] NAME...
       fuser -l
       fuser -V
Show which processes use the named files, sockets, or filesystems.

  -a,--all              display unused files too
  -i,--interactive      ask before killing (ignored without -k)
  -I,--inode            use always inodes to compare files
  -k,--kill             kill processes accessing the named file
  -l,--list-signals     list available signal names
  -m,--mount            show all processes using the named filesystems or
                        block device
  -M,--ismountpoint     fulfill request only if NAME is a mount point
  -n,--namespace SPACE  search in this name space (file, udp, or tcp)
  -s,--silent           silent operation
  -SIGNAL               send this signal instead of SIGKILL
  -u,--user             display user IDs
  -v,--verbose          verbose output
  -w,--writeonly        kill only processes with write access
  -V,--version          display version information`

const SIGNALS = ['HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'POLL', 'PWR', 'SYS']

const identity = path => { try { const info = stat(path); return { dev: info.dev, ino: info.ino } } catch { return undefined } }
const ask = question => {
  say(question)
  const buffer = new Uint8Array(64)
  const n = read(0, buffer, -1)
  return /^[yY]/.test(new TextDecoder().decode(buffer.subarray(0, Math.max(0, n))))
}

async function main() {
  // -SIGNAL is not an option getopt knows: take it out first
  let signal = 9
  const args = []
  for (const arg of argv.slice(1)) {
    const named = /^-(?:SIG)?([A-Z]+[0-9]*|\d+)$/.exec(arg)
    if (named && !/^-[aiIkmMsuvwlV4-6]+$/.test(arg)) {
      const n = /^\d+$/.test(named[1]) ? Number(named[1]) : SIGNALS.indexOf(named[1]) + 1
      if (n <= 0 || n > 64) { say(`fuser: Unknown signal; fuser -l lists signals.\n`); return 1 }
      signal = n
      continue
    }
    args.push(arg)
  }
  const { options, operands, error } = getopt(args, {
    short: 'aiIklmMn:suvwV46',
    long: { all: 'a', interactive: 'i', inode: 'I', kill: 'k', 'list-signals': 'l', mount: 'm', ismountpoint: 'M', namespace: { key: 'n', arg: 'required' }, silent: 's', user: 'u', verbose: 'v', writeonly: 'w', version: 'V', help: 'help' }
  })
  if (error) { say(`fuser: ${error}\n${usage}\n`); return 1 }
  const o = { all: false, interactive: false, kill: false, mount: false, mountpoint: false, silent: false, user: false, verbose: false }
  for (const [key, value] of options) {
    if (key === 'help') { say(usage + '\n'); return 0 }
    if (key === 'V') { say('fuser (PSmisc) 23.7 (ecmaOS)\n'); return 0 }
    if (key === 'l') { out(SIGNALS.join(' ') + '\n'); return 0 }
    if (key === 'a') o.all = true
    else if (key === 'i') o.interactive = true
    else if (key === 'k') o.kill = true
    else if (key === 'm') o.mount = true
    else if (key === 'M') o.mountpoint = true
    else if (key === 's') o.silent = true
    else if (key === 'u') o.user = true
    else if (key === 'v') o.verbose = true
    else if (key === 'n' && value !== 'file') { say(`fuser: there are no ${value} sockets to look up here\n`); return 1 }
  }
  if (operands.length === 0) { say(usage + '\n'); return 1 }

  const me = getpid()
  const list = processes()
  const names = userNames()
  const mounts = readMounts()
  const table = list.filter(p => p.pid !== me).map(p => ({ ...p, files: openFiles(p.pid).map(file => ({ ...file, id: identity(file.path) })) }))
  let found = false
  let header = false
  for (const name of operands) {
    const target = identity(name)
    if (!target) { say(`Cannot stat file ${name}: No such file or directory\n`); continue }
    let mount
    if (o.mount || o.mountpoint) {
      mount = mountFor(mounts, canonical(name))
      if (o.mountpoint && mount?.target !== canonical(name)) { say(`fuser: Specified filename ${name} is not a mountpoint.\n`); continue }
    }
    const users = []
    for (const p of table) {
      const access = new Set()
      for (const file of p.files) {
        if (!file.id) continue
        const same = o.mount ? mountFor(mounts, canonical(file.path, false))?.target === mount?.target : file.id.dev === target.dev && file.id.ino === target.ino
        if (!same) continue
        access.add(file.fd === 'cwd' ? 'c' : file.fd === 'root' ? 'r' : file.fd === 'exe' ? 'e' : 'f')
      }
      if (access.size) users.push({ p, access: ['c', 'e', 'f', 'r'].filter(letter => access.has(letter)).join('') })
    }
    if (users.length) found = true
    if (o.silent && !o.kill) continue
    if (o.verbose) {
      if (!header) { say(`${' '.repeat(21)}USER        PID ACCESS COMMAND\n`); header = true }
      if (!users.length) { if (o.all) say(`${name}:\n`); continue }
      users.forEach(({ p, access }, i) => {
        const label = i === 0 ? `${name}:` : ''
        say(`${label.padEnd(20)} ${(names.get(p.uid) ?? String(p.uid)).padEnd(10)} ${String(p.pid).padStart(5)} ${access.padEnd(6)} ${p.comm}\n`)
      })
    } else if (!o.silent && (users.length || o.all)) {
      say(`${name}:`)
      for (const { p, access } of users) {
        out(` ${String(p.pid).padStart(5)}`)
        say(`${access.replace('f', '')}${o.user ? `(${names.get(p.uid) ?? p.uid})` : ''}`)
      }
      say('\n')
    }
    if (o.kill) {
      for (const { p } of users) {
        if (o.interactive && !ask(`Kill process ${p.pid} ? (y/N) `)) continue
        await custom('proc_kill', p.pid, signal).catch(error => say(`fuser: could not kill process ${p.pid}: ${reasonOf(error)}\n`))
      }
    }
  }
  return found ? 0 : 1
}

try {
  exit(await main())
} catch (error) {
  say(`fuser: ${reasonOf(error)}\n`)
  exit(1)
}
