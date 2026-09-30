import { describe, it, expect, beforeAll } from 'vitest'
import binNodeSource from 'virtual:bin-node'

import '@zenfs/linux'
import { Process, DevTmpFS } from '@zenfs/linux'
import { defaultContext, configure, InMemory, fs } from '@zenfs/core'

import { WUNTRACED, decodeStatus, getpgid, killpg, setpgid, spawnWithFds, waitpid } from '#lib/job-control.ts'

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
})
