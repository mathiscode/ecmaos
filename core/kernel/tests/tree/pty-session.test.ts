import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { createPty, ptyIndices } from '#lib/pty.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** A program run on a pty the kernel holds the master of: what a terminal window does. */
describe('programs on a kernel-held pty, and terminal windows', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })
  afterAll(() => { for (const index of ptyIndices()) void index })

  it('runs a shell on the slave and talks to it through the master', async () => {
    const pty = createPty({ cols: 100, rows: 30 })
    let seen = ''
    const decoder = new TextDecoder()
    pty.onData(data => { seen += decoder.decode(data) })

    const proc = await kernel.spawnOnPty({ username: 'root', pty, command: '/bin/ecmash', args: ['-l'] })
    expect(proc.tty).toBe(pty.slave)
    pty.write('echo marker-$((6*7))\n')
    await until(() => seen.includes('marker-42'))
    expect(seen).toContain('marker-42')

    pty.write('exit\n')
    await Promise.race([proc.exited, until(() => false, 5000).catch(() => undefined)])
    pty.close()
    expect(ptyIndices()).not.toContain(pty.index)
  })

  const screen = (terminal: { buffer: { active: { length: number, getLine(y: number): { translateToString(trim: boolean): string } | undefined } } }) => {
    const lines: string[] = []
    for (let y = 0; y < terminal.buffer.active.length; y++) lines.push(terminal.buffer.active.getLine(y)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  it('opens a window whose terminal drives a login shell, and closing the window hangs it up', async () => {
    const opened = await kernel.openTerminalWindow({ username: 'root', title: 'term' })
    expect(kernel.windows.list().some(info => info.id === opened.window.id)).toBe(true)
    expect(opened.window.dom.querySelector('.xterm')).not.toBeNull()

    opened.terminal.input('echo window-$((6*7))\n')
    await until(() => screen(opened.terminal).includes('window-42'))

    const index = opened.pty.index
    opened.window.close(true)
    expect(ptyIndices()).not.toContain(index)
    await until(() => opened.process.code !== undefined)
  })

  it('closes the window when the shell exits', async () => {
    const opened = await kernel.openTerminalWindow({ username: 'root' })
    opened.terminal.input('exit\n')
    await until(() => kernel.windows.get(opened.window.id) === undefined)
    expect(ptyIndices()).not.toContain(opened.pty.index)
  })

  it('passes the emulator\'s size to the program', async () => {
    const opened = await kernel.openTerminalWindow({ username: 'root' })
    opened.terminal.resize(111, 33)
    opened.terminal.input('stty size\n')
    await until(() => screen(opened.terminal).includes('33 111'))
    opened.window.close(true)
  })

  it('names the pty as the terminal', async () => {
    const opened = await kernel.openTerminalWindow({ username: 'root' })
    opened.terminal.input('tty\n')
    await until(() => screen(opened.terminal).includes(`/dev/pts/${opened.pty.index}`))
    opened.window.close(true)
  })

  it('logs a user in on a login window, runs their shell, and asks again after exit', async () => {
    await kernel.users.add({ username: 'alice', password: 'wonderland', home: '/home/alice' })
    const opened = await kernel.openTerminalWindow({ username: 'root', login: true })
    expect(opened.window.info.title).toBe('Login')
    await until(() => screen(opened.terminal).includes('login: '))

    opened.terminal.input('alice\n')
    await until(() => screen(opened.terminal).includes('Password: '))
    opened.terminal.input('wrong\n')
    await until(() => screen(opened.terminal).toLowerCase().includes('incorrect') || screen(opened.terminal).toLowerCase().includes('invalid'))

    await until(() => screen(opened.terminal).split('login: ').length > 2)
    opened.terminal.input('alice\n')
    await until(() => screen(opened.terminal).split('Password: ').length > 2)
    opened.terminal.input('wonderland\n')
    await until(() => /\$|#/.test(screen(opened.terminal).split('Password: ').at(-1) ?? ''))
    opened.terminal.input('echo me-$USER-$HOME-$((6*7))\n')
    await until(() => screen(opened.terminal).includes('me-alice-/home/alice-42'))

    opened.terminal.input('exit\n')
    await until(() => screen(opened.terminal).split('login: ').length > 3)
    expect(kernel.windows.get(opened.window.id)).toBeDefined()
    opened.window.close(true)
  })

  it('lists and controls windows with wmctrl', async () => {
    const opened = await kernel.openTerminalWindow({ username: 'root', title: 'wm-test' })
    const run = async (command: string) => {
      const code = await kernel.runDetached({ username: 'root', command: 'wmctrl', args: [...command.split(' '), '>', '/tmp/wm.out', '2>&1'] })
      return { code, out: await kernel.filesystem.fs.readFile('/tmp/wm.out', 'utf-8') }
    }
    expect((await run('-l')).out).toContain(`${opened.window.id}`)
    expect((await run(`minimize ${opened.window.id}`)).code).toBe(0)
    expect(opened.window.info.state).toBe('minimized')
    expect((await run(`title ${opened.window.id} renamed`)).code).toBe(0)
    expect(opened.window.info.title).toBe('renamed')
    const missing = await run('close nope')
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('no such window')
    expect((await run(`close ${opened.window.id}`)).code).toBe(0)
    expect(kernel.windows.get(opened.window.id)).toBeUndefined()
  })

  it('lists, switches and assigns workspaces with wmctrl', async () => {
    const opened = await kernel.openTerminalWindow({ username: 'root', title: 'ws-test' })
    const run = async (command: string) => {
      const code = await kernel.runDetached({ username: 'root', command: 'wmctrl', args: [...command.split(' '), '>', '/tmp/ws.out', '2>&1'] })
      return { code, out: await kernel.filesystem.fs.readFile('/tmp/ws.out', 'utf-8') }
    }
    expect((await run('-d')).out).toBe('0 * Workspace 1\n')
    expect((await run('count 4')).code).toBe(0)
    expect((await run('-d')).out).toBe('0 * Workspace 1\n1 - Workspace 2\n2 - Workspace 3\n3 - Workspace 4\n')
    expect((await run(`-t ${opened.window.id} 2`)).code).toBe(0)
    expect(opened.window.info).toMatchObject({ workspace: 2, hidden: true })
    expect((await run('-s 2')).code).toBe(0)
    expect(kernel.windows.workspace).toBe(2)
    expect(opened.window.info.hidden).toBe(false)
    expect((await run('-l')).out).toMatch(new RegExp(`${opened.window.id}\\s+2 `))
    const bad = await run('-s 9')
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('invalid')
    expect((await run('-s 0')).code).toBe(0)
    expect((await run('count 1')).code).toBe(0)
    expect(opened.window.info).toMatchObject({ workspace: 0, hidden: false })
    opened.window.close(true)
  })

  it('a program on a pty leads its own session with the pty as its controlling terminal', async () => {
    await kernel.filesystem.fs.writeFile('/bin/ctty-test', `
      const s = globalThis.ecmaosSyscalls
      const out = []
      const note = (name, value) => out.push(name + '=' + value)
      const attempt = async (name, fn) => { try { note(name, await fn()) } catch (error) { note(name, error.code ?? error.message) } }
      const fd = s.open('/dev/pts/' + s.argv[1], 2)
      await attempt('session', () => s.getsid())
      await attempt('group', () => s.getpgid())
      await attempt('holder', () => s.ttySession(fd))
      await attempt('again', () => s.setsid())
      await attempt('drop', () => s.dropControllingTty(fd))
      await attempt('free', () => s.ttySession(fd))
      await attempt('retake', () => s.setControllingTty(fd))
      await attempt('held', () => s.ttySession(fd))
      s.write(1, new TextEncoder().encode(out.join(' ') + ' pid=' + s.getpid()))
      s.exit(0)
    `, { mode: 0o755 })
    const pty = createPty()
    let seen = ''
    const decoder = new TextDecoder()
    pty.onData(data => { seen += decoder.decode(data) })
    const proc = await kernel.spawnOnPty({ username: 'root', pty, command: '/bin/ctty-test', args: [`${pty.index}`] })
    await until(() => seen.includes('pid='), 3000).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(seen)} code=${proc.code}`) })
    const fields = Object.fromEntries(seen.trim().split(/\s+/).map(part => part.split('=')))
    const pid = Number(fields.pid)
    expect(pid).toBe(proc.pid)
    expect(Number(fields.session), seen).toBe(pid)
    expect(Number(fields.group)).toBe(pid)
    expect(Number(fields.holder)).toBe(pid)
    expect(fields.again).toMatch(/EPERM|permitted/)
    expect(fields.drop).toBe('0')
    expect(fields.free).toMatch(/ENOTTY|Inappropriate/)
    expect(fields.retake).toBe('0')
    expect(Number(fields.held)).toBe(pid)
    await proc.exited
    pty.close()
  })

  it('runs a #!ecmaos:bin:program file from ecmash through execve', async () => {
    await kernel.filesystem.fs.writeFile('/bin/hello-program', '#!ecmaos:bin:program:hello\nconsole.log("x")\n', { mode: 0o755 })
    const code = await kernel.runDetached({ username: 'root', command: 'hello-program', args: ['>', '/tmp/hp.out', '2>&1'] })
    const out = await kernel.filesystem.fs.readFile('/tmp/hp.out', 'utf-8').catch(() => '')
    expect(code, out).not.toBe(127)
    expect(out).not.toContain('ENOENT')
  })

  it('runs a program with no window and reports its exit code', async () => {
    const before = ptyIndices().length
    expect(await kernel.runDetached({ username: 'root', command: 'echo', args: ['detached-ok', '>', '/tmp/detached.out'] })).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/detached.out', 'utf-8')).toBe('detached-ok\n')
    expect(await kernel.runDetached({ username: 'root', command: 'exit', args: ['3'] })).toBe(3)
    expect(ptyIndices().length).toBe(before)
  })
})
