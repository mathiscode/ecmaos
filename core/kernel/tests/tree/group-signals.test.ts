import { beforeAll, describe, expect, it } from 'vitest'
import { Process, Signal } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { forgetGroup, setpgid, shareGroupSignals } from '#lib/job-control.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `^C` is a signal to the terminal's foreground process group, and the line discipline names one process.
 * `shareGroupSignals` is what carries it to the rest of the group: the other stages of a pipeline, or what a
 * forked subshell started (found by hand: `(sleep 60) &`, `fg`, `^C` left the `sleep` running).
 */
describe('terminal signals reach the whole foreground group', () => {
  let kernel: Kernel
  const tty = () => kernel.terminal.zfsTty as NonNullable<Kernel['terminal']['zfsTty']>

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  /** A leader, a child it started, and a grandchild: a subshell, the sleep it ran, and something below that. */
  function family() {
    const shell = new Process({ argv: ['shell'], tty: null, console: '/dev/null' })
    const leader = new Process({ argv: ['subshell'], parent: shell, tty: tty() })
    const child = new Process({ argv: ['sleep'], parent: leader, tty: tty() })
    const grandchild = new Process({ argv: ['inner'], parent: child, tty: tty() })
    setpgid(shell, leader.pid, 0)
    shareGroupSignals(leader)
    return { shell, leader, child, grandchild, dispose: () => { for (const p of [leader, child, grandchild, shell]) { forgetGroup(p.pid); try { p.dispose() } catch { /* gone */ } } } }
  }

  it('sends INT to every process in the group when it comes from the terminal', async () => {
    const { leader, child, grandchild, dispose } = family()
    try {
      tty().foreground = leader
      leader.kill(Signal.INT)
      await Promise.all([leader.exited, child.exited, grandchild.exited])
      expect(leader.killed_by).toBe(Signal.INT)
      expect(child.killed_by).toBe(Signal.INT)
      expect(grandchild.killed_by).toBe(Signal.INT)
    } finally { dispose() }
  })

  it('reaches what the process started even when that is in a group of its own', async () => {
    const { shell, leader, child, grandchild, dispose } = family()
    try {
      // a shell gives each pipeline a group of its own, forked subshells included
      setpgid(leader, child.pid, 0)
      setpgid(child, grandchild.pid, 0)
      tty().foreground = leader
      leader.kill(Signal.INT)
      await Promise.all([leader.exited, child.exited, grandchild.exited])
      expect(child.killed_by).toBe(Signal.INT)
      expect(grandchild.killed_by).toBe(Signal.INT)
      expect(shell.code).toBeUndefined()
    } finally { dispose() }
  })

  it('leaves the group alone when the signal was sent to the process by pid, not by the terminal', async () => {
    const { shell, leader, child, grandchild, dispose } = family()
    try {
      tty().foreground = shell
      leader.kill(Signal.INT)
      await leader.exited
      expect(leader.killed_by).toBe(Signal.INT)
      expect(child.code).toBeUndefined()
      expect(grandchild.code).toBeUndefined()
    } finally { dispose() }
  })

  it('does not widen a signal other than INT, QUIT and TSTP', async () => {
    const { leader, child, dispose } = family()
    try {
      tty().foreground = leader
      leader.kill(Signal.TERM)
      await leader.exited
      expect(child.code).toBeUndefined()
    } finally { dispose() }
  })
})
