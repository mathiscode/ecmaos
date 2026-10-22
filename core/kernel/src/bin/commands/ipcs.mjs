/**
 * Shows the System V IPC objects, as util-linux's `ipcs` does: `ipcs [-q] [-m] [-s] [-a]`, message queues, shared
 * memory segments and semaphore arrays, read from `/proc/sysvipc` (`tree/lib/sysv-ipc.ts`). With no option it shows
 * all three.
 */

import { readText } from './lib/proc.mjs'

const { argv, exit, write } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text))
const err = text => write(2, encoder.encode(`ipcs: ${text}\n`))

const usage = `Usage:
 ipcs [options]

Show information on IPC facilities.

Options:
 -q, --queues      message queues
 -m, --shmems      shared memory segments
 -s, --semaphores  semaphores
 -a, --all         all (default)
 -h, --help        display this help
`

/** The rows of `/proc/sysvipc/<kind>`, each by its heading's names */
function rows(kind) {
  const [heading, ...lines] = readText(`/proc/sysvipc/${kind}`).split('\n').filter(Boolean)
  const names = heading.trim().split(/\s+/)
  return lines.map(line => Object.fromEntries(line.trim().split(/\s+/).map((value, i) => [names[i], value])))
}

/** uid -> name, from `/etc/passwd` */
function users() {
  const names = new Map()
  try {
    for (const line of readText('/etc/passwd').split('\n')) {
      const [name, , uid] = line.split(':')
      if (name && uid !== undefined) names.set(uid, name)
    }
  } catch { /* numbers, then */ }
  return names
}

const pad = (value, width) => String(value).padEnd(width)
const hex = key => `0x${(Number(key) >>> 0).toString(16).padStart(8, '0')}`
const perms = mode => (parseInt(mode, 8) & 0o777).toString(8)
const SHM_DEST = 0o1000, SHM_LOCKED = 0o2000

function show(kind, names) {
  const owner = row => pad((names.get(row.uid) ?? row.uid).slice(0, 10), 10)
  // key, id and owner, then the permissions: the columns every kind begins with
  const start = (row, id) => `${hex(row.key)} ${pad(row[id], 10)} ${owner(row)} ${pad(perms(row.perms), 10)} `
  if (kind === 'msg') {
    out('\n------ Message Queues --------\n')
    out(`${['key', 'msqid', 'owner', 'perms'].map(n => pad(n, 10)).join(' ')} ${pad('used-bytes', 12)} ${pad('messages', 12)}\n`)
    for (const row of rows('msg')) out(`${start(row, 'msqid')}${pad(row.cbytes, 12)} ${pad(row.qnum, 12)}\n`)
  } else if (kind === 'shm') {
    out('\n------ Shared Memory Segments --------\n')
    out(`${['key', 'shmid', 'owner', 'perms', 'bytes', 'nattch'].map(n => pad(n, 10)).join(' ')} ${pad('status', 12)}\n`)
    for (const row of rows('shm')) {
      const mode = parseInt(row.perms, 8)
      out(`${start(row, 'shmid')}${pad(row.size, 10)} ${pad(row.nattch, 10)} ${pad(mode & SHM_DEST ? 'dest' : ' ', 6)} ${pad(mode & SHM_LOCKED ? 'locked' : ' ', 6)}\n`)
    }
  } else {
    out('\n------ Semaphore Arrays --------\n')
    out(`${['key', 'semid', 'owner', 'perms', 'nsems'].map(n => pad(n, 10)).join(' ')}\n`)
    for (const row of rows('sem')) out(`${start(row, 'semid')}${pad(row.nsems, 10)}\n`)
  }
  out('\n')
}

function main() {
  const wanted = new Set()
  for (const arg of argv.slice(1)) {
    const flags = arg.startsWith('--')
      ? [{ '--queues': 'q', '--shmems': 'm', '--semaphores': 's', '--all': 'a', '--help': 'h' }[arg] ?? arg]
      : arg.startsWith('-') && arg.length > 1 ? [...arg.slice(1)] : [arg]
    for (const flag of flags) {
      if (flag === 'h') { out(usage); return 0 }
      if (flag === 'a') { wanted.add('msg').add('shm').add('sem'); continue }
      const kind = { q: 'msg', m: 'shm', s: 'sem' }[flag]
      if (!kind) { err(`invalid option -- '${flag.replace(/^--?/, '')}'`); write(2, encoder.encode("Try 'ipcs --help' for more information.\n")); return 1 }
      wanted.add(kind)
    }
  }
  const names = users()
  for (const kind of ['msg', 'shm', 'sem']) if (!wanted.size || wanted.has(kind)) show(kind, names)
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
