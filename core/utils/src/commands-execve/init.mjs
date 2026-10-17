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
 */

import { InitEngine } from '../lib/init-engine.ts'

const sys = globalThis.ecmaosSyscalls
const { open, read, close, write, custom, spawn, exit, getpid, onSignal, pendingSignals, O_RDONLY } = sys

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
      return await call(custom, 'init_wait', timeoutMs)
    } catch (error) {
      if (String(error?.code ?? error?.message ?? error).includes('EINTR')) return 0
      throw error
    }
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

const engine = new InitEngine(host)
try {
  await engine.boot()
} catch (error) {
  host.log('error', `init: boot failed: ${error?.message ?? error}`)
}
await engine.run()

// The system has gone down: the kernel has stopped, or the page is about to reload. pid 1 does not exit.
await new Promise(() => {})
