import { beforeAll, describe, expect, it } from 'vitest'
import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('spawn with a controlling tty', () => {
  let kernel: Kernel
  const type = (d: string) => kernel.terminal.input(d, true)
  const screen = () => {
    const b = kernel.terminal.buffer.active
    let t = ''
    for (let i = 0; i < b.length; i++) t += (b.getLine(i)?.translateToString(true) ?? '') + '\n'
    return t
  }
  const read = async (p: string) => (await kernel.filesystem.fs.exists(p)) ? await kernel.filesystem.fs.readFile(p, 'utf-8') : ''

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const c = document.createElement('div'); document.body.appendChild(c); kernel.terminal.mount(c)
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
  })

  it('a program given a tty prompts, reads a silent password, and runs ecmash on it', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/getty.js', `
      const s = globalThis.ecmaosSyscalls
      const enc = new TextEncoder(), dec = new TextDecoder()
      const log = []
      const line = () => { const b = new Uint8Array(256); const n = s.read(0, b, -1); return dec.decode(b.subarray(0, n)).replace(/\\n$/, '') }
      s.write(1, enc.encode('login: '))
      const user = line()
      s.write(1, enc.encode('Password: '))
      const lflag = s.tcgetattr(0).lflag
      s.tcsetattr(0, { lflag: lflag & ~0o10 })
      const pw = line()
      s.tcsetattr(0, { lflag })
      s.write(1, enc.encode('\\n'))
      const pid = await s.spawn('/bin/ecmash', ['-ecmash'], { cwd: '/', env: { HOME: '/root', PATH: '/bin:/usr/bin', SHELL: '/bin/ecmash' }, tty: 0 })
      const r = await s.waitpid(pid, false)
      const fd = s.open('/tmp/getty.log', s.O_WRONLY | s.O_CREAT | s.O_TRUNC, 0o644)
      s.write(fd, enc.encode(JSON.stringify({ user, pw, code: r.code })))
      s.close(fd)
    `, { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/tmp/drv.js', `
      const s = globalThis.ecmaosSyscalls
      const pid = await s.spawn('/tmp/getty.js', ['getty'], { cwd: '/', tty: 0 })
      await s.waitpid(pid, false)
    `, { mode: 0o755 })

    const done = kernel.shell.execute('/tmp/drv.js')
    await waitFor(() => screen().includes('login:'))
    type('alice\r')
    await waitFor(() => screen().includes('Password:'))
    type('hunter2\r')
    await waitFor(() => screen().includes('ecmash') || true)
    await new Promise(r => setTimeout(r, 1500))
    type('echo hello > /tmp/said\r')
    await waitFor(async () => (await read('/tmp/said')).includes('hello'))
    type('exit\r')
    await done
    const log = JSON.parse(await read('/tmp/getty.log'))
    expect(log.user).toBe('alice')
    expect(log.pw).toBe('hunter2')
    expect(screen()).not.toContain('hunter2')
    expect(log.code).toBe(0)
  }, 30000)
})
