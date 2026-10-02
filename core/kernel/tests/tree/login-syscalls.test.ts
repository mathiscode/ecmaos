import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** What `/sbin/getty` asks of the kernel: a passkey attempt, a session, and the end of it. */
describe('login syscalls', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    await kernel.users.add({ username: 'alice', password: 'wonderland', home: '/home/alice' })
  })

  const run = async (name: string, source: string): Promise<unknown> => {
    await kernel.filesystem.fs.writeFile(`/tmp/${name}.js`, `
      const s = globalThis.ecmaosSyscalls
      const out = {}
      ${source}
      const fd = s.open('/tmp/${name}.json', s.O_WRONLY | s.O_CREAT | s.O_TRUNC, 0o644)
      s.write(fd, new TextEncoder().encode(JSON.stringify(out)))
      s.close(fd)
    `, { mode: 0o755 })
    expect(await kernel.shell.execute(`/tmp/${name}.js`)).toBe(0)
    return JSON.parse(await kernel.filesystem.fs.readFile(`/tmp/${name}.json`, 'utf-8'))
  }

  const session = (user: string, password: string) => `
    await s.custom('login_session', 0, '${user}', '${password}', '/tmp/session.json')
    out.session = JSON.parse(new TextDecoder().decode((() => { const fd = s.open('/tmp/session.json', s.O_RDONLY, 0); const b = new Uint8Array(4096); const n = s.read(fd, b, -1); s.close(fd); return b.subarray(0, n) })()))
  `

  it('login_begin says a password is still needed for a user with no passkey', async () => {
    expect(await run('begin', `out.n = await s.custom('login_begin', 0, 'alice')`)).toEqual({ n: 0 })
  })

  it('login_session reports a wrong password as a message, not a crash', async () => {
    const result = await run('bad', session('alice', 'nope')) as { session: { ok: boolean, message: string } }
    expect(result.session.ok).toBe(false)
    expect(result.session.message.length).toBeGreaterThan(0)
  })

  it('login_session starts the session on the tty and login_end clears the session record', async () => {
    const result = await run('good', session('alice', 'wonderland')) as { session: { ok: boolean, shell: string, home: string, username: string } }
    expect(result.session).toMatchObject({ ok: true, home: '/home/alice', username: 'alice' })
    expect(kernel.shell.env.get('USER')).toBe('alice')
    expect(kernel.shell.env.get('HOME')).toBe('/home/alice')
    expect(await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).toContain('alice\ttty0')

    await run('end', `await s.custom('login_end', 0)`)
    expect(await kernel.filesystem.fs.readFile('/run/utmp', 'utf-8')).not.toContain('alice\ttty0')
  })
})
