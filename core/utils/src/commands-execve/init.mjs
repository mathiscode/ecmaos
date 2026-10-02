/**
 * `/sbin/init`: the first process, pid 1.
 *
 * Reads `/etc/inittab` (see `lib/inittab.ts`), runs its entries, restarts the `respawn` ones when they
 * exit, and reaps every child that exits, including the orphans the kernel hands it when their parent
 * dies. `SIGHUP` makes it read the file again. The logic is `lib/init-engine.ts`; this file is only
 * how it reaches the system.
 *
 * It waits with the kernel's `init_wait` call rather than `waitpid`: `waitpid` takes a snapshot of the
 * children when it is called, fails with `ECHILD` when there are none (init often has none), and a
 * signal does not wake it. `init_wait(timeoutMs)` resolves to the pid it reaped, or 0 when the timeout
 * passed or a signal arrived. A signal that arrives while a worker sits in an async call is only
 * visible through `pendingSignals()`, and the next synchronous syscall clears it, so it is read before
 * anything else.
 *
 * pid 1 ignores every signal it has not asked to catch, so `kill -9 1` does nothing and `^C` cannot
 * reach it; only `SIGHUP` is caught here.
 */

import { InitEngine } from '../lib/init-engine.ts'

const sys = globalThis.ecmaosSyscalls
const { open, read, close, write, custom, spawn, exit, getpid, onSignal, pendingSignals, O_RDONLY } = sys

const SIGHUP = 1
const SIGNALS = { HUP: SIGHUP }

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

/** The signals seen since the engine last asked. */
const seen = new Set()

function collectSignals() {
  const mask = pendingSignals?.() ?? 0
  for (const [name, number] of Object.entries(SIGNALS)) if (mask & (1 << number)) seen.add(name)
}

const host = {
  readInittab() {
    try { return readFileText('/etc/inittab') } catch { return undefined }
  },

  async spawn(entry) {
    return await spawn(entry.argv[0], entry.argv, { cwd: '/' })
  },

  async wait(timeoutMs) {
    try {
      const pid = await custom('init_wait', timeoutMs)
      collectSignals()
      return pid
    } catch (error) {
      collectSignals()
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
    void custom('klog', level, message).catch(() => {})
  },

  async booted() {
    try { await custom('init_booted') } catch (error) { host.log('warn', `init: could not report that boot finished: ${error?.message ?? error}`) }
  },
}

if (getpid() !== 1) {
  write(2, encoder.encode('init: must be run as pid 1\n'))
  exit(1)
}

// Asking for the signal is what makes the kernel raise it on this thread instead of ignoring it.
onSignal(SIGHUP, () => seen.add('HUP'))

const engine = new InitEngine(host)
try {
  await engine.boot()
} catch (error) {
  host.log('error', `init: boot failed: ${error?.message ?? error}`)
}
await engine.run()
