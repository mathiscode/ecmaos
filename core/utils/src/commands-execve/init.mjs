/**
 * `/sbin/init`: pid 1. Reads `/etc/inittab` (`lib/inittab.ts`), runs its entries, restarts `respawn` entries when
 * they exit and reaps every child, including orphans. `SIGHUP` re-reads the file. The logic is `lib/init-engine.ts`;
 * this file connects it to the system.
 * A signal that arrives while the worker is in an async call (`custom()`, `spawn`) is visible only through
 * `pendingSignals()` and is cleared by the next synchronous syscall, so every call goes through `call()`, which reads
 * it on return, and synchronous file reads look first.
 * It waits with the kernel's `init_wait(timeoutMs)`, not `waitpid` (which snapshots the children, fails with `ECHILD`
 * when there are none and is not woken by signals); it resolves to the reaped pid, or 0 on timeout or signal.
 * pid 1 ignores signals it has not caught, so `kill -9 1` does nothing. It catches `SIGHUP` (re-read inittab) and, as
 * BusyBox does, `SIGTERM` (reboot), `SIGUSR1` (halt) and `SIGUSR2` (poweroff), which `reboot`, `halt` and `poweroff`
 * send.
 * It is also the service manager (`lib/service-manager.ts`). `systemctl` asks it for something by leaving
 * `/run/systemd/req-ID.json` and sending `SIGHUP`; the answer is `/run/systemd/rep-ID.json`. Only root can write there.
 */

import { InitEngine } from '../lib/init-engine.ts'
import { ServiceManager } from '../lib/service-manager.ts'
import { RUN_DIR } from '../lib/unit-file.ts'

const sys = globalThis.ecmaosSyscalls
const { open, read, close, write, writeAll, custom, spawn, exit, getpid, onSignal, pendingSignals, readdir, readlink, lstat, stat, mkdir, unlink, rename, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = sys

const SIGNALS = { HUP: 1, USR1: 10, USR2: 12, TERM: 15 }

const decoder = new TextDecoder()
const encoder = new TextEncoder()

function readFileText(path) {
  const fd = open(path, O_RDONLY, 0)
  try {
    const chunks = []
    const buffer = new Uint8Array(65536)
    for (;;) {
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.slice(0, n))
    }
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
    return decoder.decode(bytes)
  } finally {
    close(fd)
  }
}

const KERNEL_SCRIPT = '#!ecmaos:bin:script:'

function isKernelScript(path) {
  collectSignals()
  try {
    const fd = open(path, O_RDONLY, 0)
    try {
      const head = new Uint8Array(KERNEL_SCRIPT.length)
      const n = read(fd, head, -1)
      return decoder.decode(head.subarray(0, Math.max(0, n))) === KERNEL_SCRIPT
    } finally {
      close(fd)
    }
  } catch {
    return false
  }
}

/** The signals seen since the engine last asked. */
const seen = new Set()

/** What `pendingSignals()` held when it was last read: the bits stay set until a synchronous syscall clears them. */
let lastMask = 0

function collectSignals() {
  const mask = pendingSignals?.() ?? 0
  if (!mask) { lastMask = 0; return }
  const fresh = mask & ~lastMask
  lastMask = mask
  for (const [name, number] of Object.entries(SIGNALS)) if (fresh & (1 << number)) seen.add(name)
}

/** An async syscall, noting any signal that arrived while it ran. */
async function call(fn, ...args) {
  try {
    return await fn(...args)
  } finally {
    collectSignals()
  }
}

/** How each reaped child ended, until the engine asks */
const statuses = new Map()

/** Writes a file whole, through a temporary name so a reader never sees half of it */
function writeFileText(path, text) {
  const temporary = `${path}.${Math.random().toString(36).slice(2, 8)}`
  const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try { writeAll(fd, encoder.encode(text)) } finally { close(fd) }
  rename(temporary, path)
}

/** `/etc/passwd` and `/etc/group` as the manager needs them: an account by name, a group's id by name */
function accounts() {
  const readOr = path => { try { return readFileText(path) } catch { return '' } }
  const lines = text => text.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => line.split(':'))
  const groups = lines(readOr('/etc/group')).map(([name, , gid, members]) => ({ name, gid: Number(gid), members: (members ?? '').split(',').map(m => m.trim()).filter(Boolean) }))
  const users = lines(readOr('/etc/passwd')).map(([name, , uid, gid, , home, shell]) => ({ name, uid: Number(uid), gid: Number(gid), home: home || '/', shell: shell || '' }))
  return { users, groups }
}

const unitReader = {
  readdir(path) { try { return readdir(path) } catch { return [] } },
  readFile(path) { try { return readFileText(path) } catch { return undefined } },
  readlink(path) { try { return readlink(path) } catch { return undefined } },
  isExecutable(path) {
    try { const info = stat(path); return (info.mode & 0o170000) === 0o100000 && (info.mode & 0o111) !== 0 } catch { return false }
  }
}

const services = new ServiceManager({
  reader: unitReader,
  async spawn(argv, { cwd, env, credentials }) {
    return await call(spawn, argv[0], argv, { cwd, env, pgid: 0, ...(credentials ? { credentials } : {}) })
  },
  async killpg(pgid, signal) { await call(custom, 'proc_killpg', pgid, signal) },
  async kill(pid, signal) { await call(custom, 'proc_kill', pid, signal) },
  alive(pid) { try { lstat(`/proc/${pid}`); return true } catch { return false } },
  writeFile: writeFileText,
  mkdir(path) { try { stat(path) } catch { mkdir(path, 0o755) } },
  account(name) {
    const { users, groups } = accounts()
    const user = users.find(candidate => candidate.name === name)
    if (!user) return undefined
    return { ...user, groups: groups.filter(group => group.members.includes(name) && group.gid !== user.gid).map(group => group.gid) }
  },
  groupId(name) { return accounts().groups.find(group => group.name === name)?.gid },
  syslog(message) {
    try {
      const fd = open('/dev/log', O_WRONLY)
      try { writeAll(fd, encoder.encode(`<30>init[1]: ${message}\n`)) } finally { close(fd) }
    } catch { /* no log yet */ }
  },
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: timer => clearTimeout(timer)
})

const host = {
  readInittab() {
    collectSignals()
    try { return readFileText('/etc/inittab') } catch { return undefined }
  },

  async spawn(entry) {
    const [path, ...args] = entry.argv
    // The kernel's own shell runs these, not `execve`, and it is shared with whoever is at the
    // terminal, so only the entries that block boot may use it.
    if (isKernelScript(path)) {
      if (!['sysinit', 'wait', 'shutdown'].includes(entry.action)) throw new Error('a kernel-shell script can only be a sysinit, wait or shutdown entry')
      return await call(custom, 'init_script', path, JSON.stringify(args))
    }
    // Its own process group, as a shell gives each job: init's children would otherwise all share pgid 1.
    // As in BusyBox, an entry whose id names a terminal (`tty2`) runs on it.
    const terminal = /^tty(\d+)$/.exec(entry.id)
    return await call(spawn, path, entry.argv, { cwd: '/', pgid: 0, ...(terminal ? { tty: Number(terminal[1]) } : {}) })
  },

  /** The level `telinit` wrote; absent until it has run */
  readRunlevel() {
    collectSignals()
    try { return readFileText('/run/runlevel').trim() || undefined } catch { return undefined }
  },

  async kill(pid, signal) {
    await call(custom, 'proc_kill', pid, signal)
  },

  async wait(timeoutMs) {
    collectSignals()
    if (seen.size) return 0 // a signal is already waiting: let the engine act on it first
    try {
      const packed = await call(custom, 'init_wait', timeoutMs)
      if (!packed) return 0
      const pid = Math.floor(packed / 65536)
      const status = packed % 65536
      statuses.set(pid, status & 0x7f ? { signal: status & 0x7f } : { code: (status >> 8) & 0xff })
      return pid
    } catch (error) {
      if (String(error?.code ?? error?.message ?? error).includes('EINTR')) return 0
      throw error
    }
  },

  statusOf(pid) {
    const status = statuses.get(pid) ?? {}
    statuses.delete(pid)
    return status
  },

  takeRequests() {
    collectSignals()
    const requests = []
    let names = []
    try { names = readdir(RUN_DIR) } catch { return requests }
    for (const name of names) {
      if (!/^req-[\w-]+\.json$/.test(name)) continue
      const path = `${RUN_DIR}/${name}`
      try {
        requests.push(JSON.parse(readFileText(path)))
      } catch (error) {
        host.log('warn', `init: unreadable request ${name}: ${error?.message ?? error}`)
      }
      try { unlink(path) } catch { /* taken */ }
    }
    return requests
  },

  reply(answer) {
    if (!/^[\w-]+$/.test(String(answer.id))) return
    try { writeFileText(`${RUN_DIR}/rep-${answer.id}.json`, JSON.stringify(answer) + '\n') } catch (error) { host.log('warn', `init: cannot answer ${answer.id}: ${error?.message ?? error}`) }
  },

  takeSignals() {
    const names = [...seen]
    seen.clear()
    return names
  },

  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),

  log(level, message) {
    void call(custom, 'klog', level, message).catch(() => {})
  },

  async killAll(signal) {
    return await call(custom, 'init_killall', signal)
  },

  async alive() {
    return await call(custom, 'init_alive')
  },

  async finish(mode) {
    await call(custom, 'system_stop', mode)
  },

  async booted() {
    try { await call(custom, 'init_booted') } catch (error) { host.log('warn', `init: could not report that boot finished: ${error?.message ?? error}`) }
  },
}

if (getpid() !== 1) {
  write(2, encoder.encode('init: must be run as pid 1\n'))
  exit(1)
}

// Asking for a signal is what makes the kernel raise it on this thread instead of ignoring it.
for (const [name, number] of Object.entries(SIGNALS)) onSignal(number, () => seen.add(name))

const engine = new InitEngine(host, undefined, undefined, services)
try {
  await engine.boot()
} catch (error) {
  host.log('error', `init: boot failed: ${error?.message ?? error}`)
}
await engine.run()

// The system has gone down: the kernel has stopped, or the page is about to reload. pid 1 does not exit.
await new Promise(() => {})
