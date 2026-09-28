import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** See `shell-jobs-execve.test.ts` for why this polls rather than sleeping a fixed amount. */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * What `^C` does to the *shell*, as opposed to what it does to the process it kills.
 *
 * Two behaviors were missing, both found by a live browser smoke test rather than by any unit test:
 *
 * - `trap 'cmd' INT` never fired. While a foreground `execve`'d process holds the terminal,
 *   `Terminal.keyHandler` returns early (`if (this._ttyInput) return`) because the `@zenfs/linux`
 *   line discipline owns the keyboard and raises `SIGINT` itself via `ISIG` -- so the
 *   `runTrap('INT')` call in that key handler never ran for exactly the case a trap is written for.
 * - the rest of the command list kept going: `echo a; sleep 25; echo b` still printed `b` after the
 *   `^C` that killed the sleep, where bash aborts the whole list.
 *
 * Both now route through `Shell.notifyInterrupted`, which `Kernel.executeViaExecve` calls where the
 * signal actually lands (`proc.killed_by === Signal.INT`).
 */
describe('Shell ^C handling', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    await kernel.filesystem.fs.writeFile('/tmp/sleeper.js', 'await new Promise(r => setTimeout(r, 5000))', { mode: 0o755 })
  })

  /** Starts `line`, waits for its real process to exist, then interrupts it. */
  const runAndInterrupt = async (line: string): Promise<number> => {
    const promise = kernel.shell.execute(line)
    await waitFor(() => (kernel.shell.foregroundJob?.processes.length ?? 0) > 0)
    for (const proc of kernel.shell.foregroundJob!.processes) proc.kill(2 /* SIGINT */)
    return promise
  }

  it('marks the shell interrupted when a foreground process is killed by SIGINT', async () => {
    await runAndInterrupt('/tmp/sleeper.js')
    expect(kernel.shell.interrupted).toBe(true)
  })

  it('aborts the rest of a semicolon list', async () => {
    const marker = '/tmp/interrupt-list.out'
    if (await kernel.filesystem.fs.exists(marker)) await kernel.filesystem.fs.unlink(marker)

    await runAndInterrupt(`/tmp/sleeper.js; echo should-not-run > ${marker}`)

    expect(await kernel.filesystem.fs.exists(marker)).toBe(false)
  })

  it('runs a trap ... INT handler', async () => {
    const marker = '/tmp/interrupt-trap.out'
    if (await kernel.filesystem.fs.exists(marker)) await kernel.filesystem.fs.unlink(marker)

    kernel.shell.setTrap(`echo trapped > ${marker}`, 'INT')
    try {
      await runAndInterrupt('/tmp/sleeper.js')
      // The handler is dispatched from `notifyInterrupted`; give its own command a moment to land.
      await waitFor(async () => await kernel.filesystem.fs.exists(marker) as unknown as boolean)
        .catch(() => {})
      expect(await kernel.filesystem.fs.exists(marker)).toBe(true)
      expect(await kernel.filesystem.fs.readFile(marker, 'utf-8')).toContain('trapped')
    } finally {
      kernel.shell.setTrap(undefined, 'INT')
    }
  })

  it('clears the interrupted flag for the next line', async () => {
    await runAndInterrupt('/tmp/sleeper.js')
    expect(kernel.shell.interrupted).toBe(true)

    const code = await kernel.shell.execute('echo after-interrupt > /tmp/interrupt-next.out')
    expect(code).toBe(0)
    expect(kernel.shell.interrupted).toBe(false)
    expect(await kernel.filesystem.fs.readFile('/tmp/interrupt-next.out', 'utf-8')).toBe('after-interrupt\n')
  })

  it('leaves an uninterrupted list alone', async () => {
    const code = await kernel.shell.execute('echo one > /tmp/interrupt-none.out; echo two >> /tmp/interrupt-none.out')
    expect(code).toBe(0)
    expect(kernel.shell.interrupted).toBe(false)
    expect(await kernel.filesystem.fs.readFile('/tmp/interrupt-none.out', 'utf-8')).toBe('one\ntwo\n')
  })
})

/**
 * Regression coverage for a bug the unit tests above missed and a live browser run caught.
 *
 * `Shell.execute` cleared `_interrupted` on entry, and `runTrap` dispatches its handler *through*
 * `execute` -- so setting the flag and then running the handler wiped the flag immediately, and the
 * rest of an interrupted `;` list ran anyway. The tests above passed regardless because they kill
 * the process directly with no `INT` trap registered, so `runTrap` returned without doing anything.
 *
 * The same nesting applies to command substitution and function bodies, which also reach `execute`.
 */
describe('Shell ^C with a trap registered', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    await kernel.filesystem.fs.writeFile('/tmp/trap-sleeper.js', 'await new Promise(r => setTimeout(r, 5000))', { mode: 0o755 })
  })

  const runAndInterrupt = async (line: string): Promise<number> => {
    const promise = kernel.shell.execute(line)
    const start = Date.now()
    while ((kernel.shell.foregroundJob?.processes.length ?? 0) === 0) {
      if (Date.now() - start > 3000) throw new Error('timed out waiting for process')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    for (const proc of kernel.shell.foregroundJob!.processes) proc.kill(2 /* SIGINT */)
    return promise
  }

  it('still aborts the rest of the list when an INT trap is registered', async () => {
    const trapMarker = '/tmp/trap-fired.out'
    const listMarker = '/tmp/trap-list-continued.out'
    for (const f of [trapMarker, listMarker]) {
      if (await kernel.filesystem.fs.exists(f)) await kernel.filesystem.fs.unlink(f)
    }

    kernel.shell.setTrap(`echo fired > ${trapMarker}`, 'INT')
    try {
      await runAndInterrupt(`/tmp/trap-sleeper.js; echo continued > ${listMarker}`)

      expect(await kernel.filesystem.fs.exists(trapMarker)).toBe(true)
      expect(await kernel.filesystem.fs.exists(listMarker)).toBe(false)
      expect(kernel.shell.interrupted).toBe(true)
    } finally {
      kernel.shell.setTrap(undefined, 'INT')
    }
  })

  it('runs every command of a multi-command trap handler', async () => {
    const marker = '/tmp/trap-multi.out'
    if (await kernel.filesystem.fs.exists(marker)) await kernel.filesystem.fs.unlink(marker)

    kernel.shell.setTrap(`echo one > ${marker}; echo two >> ${marker}`, 'INT')
    try {
      await runAndInterrupt('/tmp/trap-sleeper.js')
      expect(await kernel.filesystem.fs.readFile(marker, 'utf-8')).toBe('one\ntwo\n')
    } finally {
      kernel.shell.setTrap(undefined, 'INT')
    }
  })

  it('does not let a command substitution clear the interrupt', async () => {
    const marker = '/tmp/trap-cmdsub.out'
    if (await kernel.filesystem.fs.exists(marker)) await kernel.filesystem.fs.unlink(marker)

    kernel.shell.setTrap('X=$(echo nested)', 'INT')
    try {
      await runAndInterrupt(`/tmp/trap-sleeper.js; echo continued > ${marker}`)
      expect(kernel.shell.interrupted).toBe(true)
      expect(await kernel.filesystem.fs.exists(marker)).toBe(false)
    } finally {
      kernel.shell.setTrap(undefined, 'INT')
    }
  })
})
