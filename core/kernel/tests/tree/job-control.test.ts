import { describe, it, expect, beforeAll } from 'vitest'
import binNodeSource from 'virtual:bin-node'

import '@zenfs/linux'
import { Process, DevTmpFS } from '@zenfs/linux'
import { defaultContext, configure, InMemory, fs } from '@zenfs/core'

import { WUNTRACED, decodeStatus, dropControllingTty, getpgid, getsid, killpg, setControllingTty, setpgid, setsid, spawnWithFds, ttySession, waitpid } from '#lib/job-control.ts'

/** The process half of job control: wait statuses, process groups, and a spawn that wires fds. */
describe('job-control shim', () => {
  let parent: Process

  beforeAll(async () => {
    await configure({ mounts: { '/': InMemory, '/dev': new DevTmpFS() } })
    await fs.promises.writeFile('/dev/console', '')
    await fs.promises.mkdir('/bin')
    await fs.promises.writeFile('/bin/node', binNodeSource, { mode: 0o755 })
    await fs.promises.writeFile('/exit42.js', `globalThis.ecmaosSyscalls.exit(42)`, { mode: 0o755 })
    await fs.promises.writeFile('/hang.js', `
      const { pipe, read } = globalThis.ecmaosSyscalls
      const [r] = pipe()
      read(r, new Uint8Array(1), -1)
    `, { mode: 0o755 })
    await fs.promises.writeFile('/say.js', `
      const { write, exit, argv } = globalThis.ecmaosSyscalls
      write(1, new TextEncoder().encode(argv[1] + ':' + globalThis.ecmaosSyscalls.env.WHO))
      exit(0)
    `, { mode: 0o755 })
    parent = new Process({ context: defaultContext })
  })

  it('distinguishes an exit code from a death by signal', async () => {
    const a = await spawnWithFds(parent, '/exit42.js', ['/exit42.js'], {})
    const done = await waitpid(parent, a.pid, false)
    expect(Math.floor(done / 65536)).toBe(a.pid)
    expect(decodeStatus(done % 65536)).toEqual({ code: 42 })

    const b = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {})
    b.kill('SIGTERM')
    const killed = await waitpid(parent, b.pid, false)
    expect(decodeStatus(killed % 65536)).toEqual({ signal: 15 })
  })

  it('waitpid with WNOHANG returns 0 until the child is done', async () => {
    const child = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {})
    expect(await waitpid(parent, child.pid, true)).toBe(0)
    child.kill('SIGKILL')
    await child.exited
    const done = await waitpid(parent, -1, true)
    expect(Math.floor(done / 65536)).toBe(child.pid)
  })

  it('reports ECHILD for a pid that is not a child', async () => {
    await expect(waitpid(parent, 999999, false)).rejects.toMatchObject({ errno: expect.any(Number) })
  })

  it('killpg reaches every member of a group', async () => {
    const a = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {}, { pgid: 0 })
    const b = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {})
    setpgid(parent, b.pid, a.pid)
    expect(getpgid(b)).toBe(a.pid)
    expect(killpg(a.pid, 9)).toBe(2)
    await Promise.all([a.exited, b.exited])
    expect(decodeStatus((await waitpid(parent, a.pid, false)) % 65536)).toEqual({ signal: 9 })
    await waitpid(parent, b.pid, false)
  })

  it('installs the requested descriptors and a per-spawn environment', async () => {
    const r = fs.openSync.call(parent.context, '/out', 'w+')
    const child = await spawnWithFds(parent, '/say.js', ['/say.js', 'hello'], { WHO: 'bob' }, { fds: { 1: r } })
    await waitpid(parent, child.pid, false)
    fs.closeSync.call(parent.context, r)
    expect(await fs.promises.readFile('/out', 'utf-8')).toBe('hello:bob')
  })

  it('WUNTRACED reports a stop once, not again until it has run and stopped anew', async () => {
    const child = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {})
    child.kill('SIGTSTP')
    const stopped = await waitpid(parent, child.pid, WUNTRACED)
    expect(Math.floor(stopped / 65536)).toBe(child.pid)
    expect(stopped % 65536).toBe((20 << 8) | 0x7f)
    // Reported already, so a non-blocking look finds nothing new, and the child is not reaped.
    expect(await waitpid(parent, child.pid, WUNTRACED | 1)).toBe(0)
    expect(child.code).toBeUndefined()
    // Continued by `killpg`, which is what the shell uses, then stopped again before anyone looked.
    setpgid(parent, child.pid, child.pid)
    killpg(child.pid, 18)
    child.kill('SIGTSTP')
    expect((await waitpid(parent, child.pid, WUNTRACED)) % 65536).toBe((20 << 8) | 0x7f)
    child.kill('SIGKILL')
    expect(decodeStatus((await waitpid(parent, child.pid, WUNTRACED)) % 65536)).toEqual({ signal: 9 })
  })

  it('a wait without WUNTRACED does not report a stop', async () => {
    const child = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {})
    child.kill('SIGTSTP')
    expect(await waitpid(parent, child.pid, 1)).toBe(0)
    child.kill('SIGKILL')
    await waitpid(parent, child.pid, false)
  })

  describe('sessions and controlling terminals', () => {
    const fakeTty = () => ({ foreground: undefined as Process | undefined }) as unknown as NonNullable<Process['tty']>

    it('a child starts in its parent\'s session, and setsid starts a new one with no terminal', async () => {
      const child = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {})
      expect(getsid(child)).toBe(getsid(parent))
      expect(setsid(child)).toBe(child.pid)
      expect(getsid(child)).toBe(child.pid)
      expect(getpgid(child)).toBe(child.pid)
      expect(child.tty).toBeNull()
      child.kill('SIGKILL')
      await waitpid(parent, child.pid, false)
    })

    it('a process group leader with others in its group cannot setsid, and a session leader cannot again', async () => {
      const child = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {}, { pgid: 0 })
      const mate = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {}, { pgid: child.pid })
      expect(() => setsid(child)).toThrow(/not permitted/)
      mate.kill('SIGKILL')
      await waitpid(parent, mate.pid, false)
      // alone in its group, a leader may start a session
      expect(setsid(child)).toBe(child.pid)
      child.kill('SIGKILL')
      await waitpid(parent, child.pid, false)

      const leader = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {}, { setsid: true })
      expect(getsid(leader)).toBe(leader.pid)
      expect(() => setsid(leader)).toThrow(/not permitted/)
      leader.kill('SIGKILL')
      await waitpid(parent, leader.pid, false)
    })

    it('only a session leader takes a terminal, one session at a time, and it is released when the leader exits', async () => {
      const tty = fakeTty()
      const plain = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {})
      expect(() => setControllingTty(plain, tty, false)).toThrow(/not permitted/)

      const one = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {}, { setsid: true })
      const worker = await spawnWithFds(one, '/hang.js', ['/hang.js'], {})
      expect(worker.tty).toBe(parent.tty)
      expect(setControllingTty(one, tty, false)).toBe(0)
      expect(ttySession(tty)).toBe(one.pid)
      expect(tty.foreground).toBe(one)
      expect(one.tty).toBe(tty)

      const two = await spawnWithFds(parent, '/hang.js', ['/hang.js'], {}, { setsid: true })
      expect(() => setControllingTty(two, tty, false)).toThrow(/not permitted/)
      // only root may steal one, and the session that lost it is left with none
      expect(setControllingTty(two, tty, true)).toBe(0)
      expect(ttySession(tty)).toBe(two.pid)
      expect(one.tty).toBeNull()

      expect(dropControllingTty(two)).toBe(0)
      expect(ttySession(tty)).toBeUndefined()
      expect(() => dropControllingTty(two)).toThrow(/Inappropriate/)

      expect(setControllingTty(two, tty, false)).toBe(0)
      two.kill('SIGKILL')
      await waitpid(parent, two.pid, false)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(ttySession(tty)).toBeUndefined()

      for (const proc of [plain, one, worker]) { proc.kill('SIGKILL'); await waitpid(proc.parent!, proc.pid, false) }
    })
  })
})
