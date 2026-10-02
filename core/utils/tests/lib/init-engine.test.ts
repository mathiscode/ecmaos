import { describe, expect, it } from 'vitest'

import { InitEngine } from '../../src/lib/init-engine.ts'
import type { InitHost, ShutdownMode } from '../../src/lib/init-engine.ts'
import type { InitEntry } from '../../src/lib/inittab.ts'

/**
 * A host over a fake clock. `wait` answers from a script: each step is told the timeout the engine
 * asked for and returns the pid that "exited" (0 for a timeout or a signal). When the script runs out
 * the engine is stopped, so `run()` returns.
 */
class FakeHost implements InitHost {
  clock = 0
  nextPid = 100
  inittab: string | undefined
  spawned: Array<{ pid: number, command: string, at: number }> = []
  logs: string[] = []
  timeouts: number[] = []
  signals: string[] = []
  failing = new Set<string>()
  bootedAt: number | undefined
  order: string[] = []
  script: Array<(timeout: number) => number> = []
  engine!: InitEngine
  kills: number[] = []
  finished: ShutdownMode[] = []
  aliveFn: () => number = () => 0
  advanceOnEmpty = false

  readInittab() { return this.inittab }
  now() { return this.clock }
  async sleep(ms: number) { this.clock += ms }
  log(level: string, message: string) { this.logs.push(`${level}: ${message}`) }
  takeSignals() { const taken = this.signals; this.signals = []; return taken }

  async spawn(entry: InitEntry) {
    if (this.failing.has(entry.command)) throw new Error('no such file')
    const pid = this.nextPid++
    this.spawned.push({ pid, command: entry.command, at: this.clock })
    this.order.push(`spawn ${entry.command}`)
    return pid
  }

  async booted() { this.order.push('booted'); this.bootedAt = this.spawned.length }
  async killAll(signal: number) { const reached = this.aliveFn(); this.kills.push(signal); this.order.push(`kill ${signal}`); return reached }
  async alive() { return this.aliveFn() }
  async finish(mode: ShutdownMode) { this.finished.push(mode); this.order.push(`finish ${mode}`) }

  async wait(timeout: number) {
    this.timeouts.push(timeout)
    const step = this.script.shift()
    if (!step) { this.engine.stop(); if (this.advanceOnEmpty && timeout > 0) this.clock += timeout; return 0 }
    return step(timeout)
  }

  pidOf(command: string, nth = 0) { return this.spawned.filter(entry => entry.command === command)[nth]!.pid }
  count(command: string) { return this.spawned.filter(entry => entry.command === command).length }
}

const make = (inittab: string | undefined) => {
  const host = new FakeHost()
  host.inittab = inittab
  host.engine = new InitEngine(host, { initialMs: 1000, maxMs: 8000, resetAfterMs: 30_000 }, { shutdownEntryMs: 5000, termGraceMs: 3000, killGraceMs: 1000 })
  return host
}

describe('InitEngine boot', () => {
  it('runs sysinit, then wait, then reports booted, then starts once and respawn entries', async () => {
    const host = make([
      '::respawn:/bin/daemon',
      '::once:/bin/once',
      '::wait:/bin/wait',
      '::sysinit:/bin/first',
      '::sysinit:/bin/second'
    ].join('\n'))
    // each blocking entry is reaped as soon as it is waited for
    host.script = [() => host.pidOf('/bin/first'), () => host.pidOf('/bin/second'), () => host.pidOf('/bin/wait')]
    await host.engine.boot()
    expect(host.order).toEqual([
      'spawn /bin/first', 'spawn /bin/second', 'spawn /bin/wait',
      'booted',
      'spawn /bin/once', 'spawn /bin/daemon'
    ])
  })

  it('waits for the entry it started, and reaps an unrelated exit meanwhile', async () => {
    const host = make('::sysinit:/bin/slow\n::respawn:/bin/daemon')
    host.script = [() => 999, () => host.pidOf('/bin/slow')]
    await host.engine.boot()
    expect(host.timeouts.slice(0, 2)).toEqual([-1, -1])
    expect(host.order).toEqual(['spawn /bin/slow', 'booted', 'spawn /bin/daemon'])
  })

  it('carries on when a sysinit command cannot be started', async () => {
    const host = make('::sysinit:/bin/missing\n::sysinit:/bin/there\n::respawn:/bin/daemon')
    host.failing.add('/bin/missing')
    host.script = [() => host.pidOf('/bin/there')]
    await host.engine.boot()
    expect(host.logs).toContain('error: init: cannot start /bin/missing: no such file')
    expect(host.order).toEqual(['spawn /bin/there', 'booted', 'spawn /bin/daemon'])
  })

  it('uses the default inittab when there is none, and says so', async () => {
    const host = make(undefined)
    host.script = [() => host.pidOf('/boot/init')]
    await host.engine.boot()
    expect(host.logs).toContain('info: init: no /etc/inittab, using the default')
    expect(host.order).toEqual(['spawn /boot/init', 'booted', 'spawn /bin/crond'])
  })

  it('reports a bad inittab line with its number and runs the rest', async () => {
    const host = make('::respawn:/bin/daemon\nnonsense\n::once:/bin/once')
    await host.engine.boot()
    expect(host.logs).toContain('warn: init: inittab line 2: expected id:runlevels:action:command')
    expect(host.order).toEqual(['booted', 'spawn /bin/once', 'spawn /bin/daemon'])
  })
})

describe('InitEngine run', () => {
  it('restarts a respawn entry after the backoff, and the backoff doubles', async () => {
    const host = make('::respawn:/bin/daemon')
    await host.engine.boot()
    host.script = [
      () => { host.clock += 10; return host.pidOf('/bin/daemon', 0) },            // dies after 10 ms
      (timeout) => { expect(timeout).toBe(1000); host.clock += timeout; return 0 }, // waits 1000, then restarts
      () => { host.clock += 10; return host.pidOf('/bin/daemon', 1) },            // dies again
      (timeout) => { expect(timeout).toBe(2000); host.clock += timeout; return 0 }
    ]
    await host.engine.run()
    expect(host.count('/bin/daemon')).toBe(3)
    expect(host.logs.filter(line => line.includes('starting it again'))).toEqual([
      'warn: init: /bin/daemon exited, starting it again in 1000 ms',
      'warn: init: /bin/daemon exited, starting it again in 2000 ms'
    ])
  })

  it('restarts a service that ran for a long time at once', async () => {
    const host = make('::respawn:/bin/daemon')
    await host.engine.boot()
    host.script = [
      () => { host.clock += 60_000; return host.pidOf('/bin/daemon', 0) },
      (timeout) => { expect(timeout).toBe(0); return 0 }
    ]
    await host.engine.run()
    expect(host.count('/bin/daemon')).toBe(2)
    expect(host.logs.some(line => line.includes('starting it again'))).toBe(false)
  })

  it('waits for ever when nothing is due', async () => {
    const host = make('::respawn:/bin/daemon')
    await host.engine.boot()
    await host.engine.run()
    expect(host.timeouts).toEqual([-1])
  })

  it('reaps a child it does not know without restarting or logging anything', async () => {
    const host = make('::respawn:/bin/daemon')
    await host.engine.boot()
    const logged = host.logs.length
    host.script = [() => 4242]
    await host.engine.run()
    expect(host.count('/bin/daemon')).toBe(1)
    expect(host.logs.length).toBe(logged)
    expect(host.timeouts).toEqual([-1, -1])
  })

  it('does not restart a once entry', async () => {
    const host = make('::once:/bin/once')
    await host.engine.boot()
    host.script = [() => host.pidOf('/bin/once')]
    await host.engine.run()
    expect(host.count('/bin/once')).toBe(1)
    expect(host.engine.snapshot().pending).toEqual([])
  })

  it('backs off a respawn command that cannot be started, and keeps trying', async () => {
    const host = make('::respawn:/bin/missing')
    host.failing.add('/bin/missing')
    await host.engine.boot()
    expect(host.engine.snapshot().pending).toEqual([['/bin/missing', 1000]])
    host.script = [(timeout) => { expect(timeout).toBe(1000); host.clock += 1000; return 0 }]
    await host.engine.run()
    expect(host.engine.snapshot().pending).toEqual([['/bin/missing', 3000]])
  })

  it('keeps going after a failed wait', async () => {
    const host = make('::respawn:/bin/daemon')
    await host.engine.boot()
    host.script = [() => { throw new Error('boom') }, () => host.pidOf('/bin/daemon'), (timeout) => { host.clock += timeout; return 0 }]
    await host.engine.run()
    expect(host.logs).toContain('error: init: boom')
    expect(host.clock).toBe(2000) // one second asleep after the failure, one second of backoff
    expect(host.count('/bin/daemon')).toBe(2)
  })
})

describe('InitEngine reload', () => {
  it('starts a new respawn entry on SIGHUP and leaves a running one alone', async () => {
    const host = make('::respawn:/bin/a')
    await host.engine.boot()
    host.inittab = '::respawn:/bin/a\n::respawn:/bin/b'
    host.script = [() => { host.signals.push('HUP'); return 0 }]
    await host.engine.run()
    expect(host.count('/bin/a')).toBe(1)
    expect(host.count('/bin/b')).toBe(1)
    expect(host.logs).toContain('info: init: read inittab again (2 entries, 1 started)')
  })

  it('stops restarting an entry that was removed, and drops its pending restart', async () => {
    const host = make('::respawn:/bin/a\n::respawn:/bin/b')
    await host.engine.boot()
    host.script = [
      () => host.pidOf('/bin/a'),                       // a dies: a restart is pending
      () => { host.inittab = '::respawn:/bin/b'; host.signals.push('HUP'); return 0 },
      () => host.pidOf('/bin/b')                        // b is still wanted and still restarts later
    ]
    await host.engine.run()
    expect(host.count('/bin/a')).toBe(1)
    expect(host.engine.snapshot().pending.map(([command]) => command)).toEqual(['/bin/b'])
  })

  it('does not restart an entry that was removed while it was still running', async () => {
    const host = make('::respawn:/bin/a')
    await host.engine.boot()
    host.script = [
      () => { host.inittab = '# nothing'; host.signals.push('HUP'); return 0 },
      () => host.pidOf('/bin/a')
    ]
    await host.engine.run()
    expect(host.count('/bin/a')).toBe(1)
    expect(host.engine.snapshot().pending).toEqual([])
  })
})

describe('InitEngine shutdown', () => {
  it.each([['TERM', 'reboot'], ['USR1', 'halt'], ['USR2', 'poweroff']])('%s means %s', async (signal, mode) => {
    const host = make('::respawn:/bin/daemon')
    await host.engine.boot()
    host.script = [() => { host.signals.push(signal!); return 0 }]
    await host.engine.run()
    expect(host.finished).toEqual([mode])
    expect(host.logs).toContain(`warn: init: the system is going down for ${mode}`)
  })

  it('runs the shutdown entries in order and waits for each, then stops everything, then hands over', async () => {
    const host = make('::shutdown:/bin/one\n::respawn:/bin/daemon\n::shutdown:/bin/two')
    await host.engine.boot()
    host.order.length = 0
    host.script = [
      () => { host.signals.push('USR1'); return 0 },
      () => host.pidOf('/bin/one'),
      () => host.pidOf('/bin/two')
    ]
    await host.engine.run()
    expect(host.order).toEqual(['spawn /bin/one', 'spawn /bin/two', 'kill 15', 'finish halt'])
  })

  it('gives up on a shutdown entry that never finishes', async () => {
    const host = make('::shutdown:/bin/hang')
    await host.engine.boot()
    host.script = [() => { host.signals.push('TERM'); return 0 }, (timeout) => { host.clock += timeout; return 0 }]
    await host.engine.run()
    expect(host.logs).toContain('warn: init: /bin/hang did not finish in 5000 ms')
    expect(host.finished).toEqual(['reboot'])
  })

  it('kills what ignores SIGTERM, and says how many', async () => {
    const host = make('# nothing')
    await host.engine.boot()
    host.aliveFn = () => host.kills.includes(9) ? 0 : 2
    host.advanceOnEmpty = true
    host.script = [() => { host.signals.push('TERM'); return 0 }]
    await host.engine.run()
    expect(host.kills).toEqual([15, 9])
    expect(host.logs).toContain('warn: init: 2 processes ignored SIGTERM and were killed')
    expect(host.finished).toEqual(['reboot'])
  })

  it('does not wait out the grace period when everything exits at once', async () => {
    const host = make('# nothing')
    await host.engine.boot()
    host.script = [() => { host.signals.push('TERM'); return 0 }]
    await host.engine.run()
    expect(host.kills).toEqual([15])
    expect(host.clock).toBe(0)
  })

  it('does not restart a respawn entry that exits while the system goes down', async () => {
    const host = make('::respawn:/bin/daemon')
    await host.engine.boot()
    let alive = 1
    host.aliveFn = () => alive
    host.script = [
      () => { host.signals.push('TERM'); return 0 },
      () => { alive = 0; return host.pidOf('/bin/daemon') }
    ]
    await host.engine.run()
    expect(host.count('/bin/daemon')).toBe(1)
    expect(host.engine.snapshot().pending).toEqual([])
    expect(host.finished).toEqual(['reboot'])
  })

  it('acts on the first request only', async () => {
    const host = make('# nothing')
    await host.engine.boot()
    host.script = [() => { host.signals.push('USR2', 'TERM'); return 0 }]
    await host.engine.run()
    expect(host.finished).toEqual(['poweroff'])
  })
})
