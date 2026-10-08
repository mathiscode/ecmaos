import { beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'
import { boundContexts } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * pid 1 is a real process: `/sbin/init`, running `/etc/inittab`. These boot a kernel and check what
 * it started, what it restarts, what it ignores, and who may use the calls it needs from the main thread.
 */
describe('/sbin/init as pid 1', () => {
  let kernel: Kernel
  let n = 0

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const ps = async () => {
    const file = `/tmp/init-process-ps-${n++}.out`
    await kernel.shell.execute(`ps > ${file}`)
    const text = await kernel.filesystem.fs.readFile(file, 'utf-8')
    return text.split('\n').slice(1).filter(Boolean).map(line => {
      const [pid, ppid, uid, ...command] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), uid: Number(uid), command: command.join(' ') }
    })
  }
  const until = async (check: () => Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await check()) return true; await sleep(50) }
    return false
  }

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

  it('installs the program in /sbin and writes a default /etc/inittab', async () => {
    expect(await kernel.filesystem.fs.exists('/sbin/init')).toBe(true)
    expect(await kernel.filesystem.fs.exists('/bin/init')).toBe(false)
    const inittab = await kernel.filesystem.fs.readFile('/etc/inittab', 'utf-8')
    expect(inittab).toContain('::sysinit:/boot/init')
    expect(inittab).toContain('::respawn:/bin/crond')
  })

  it('runs as pid 1 with no parent, on its own descriptors and with no controlling terminal', async () => {
    const init = processes.get(1)!
    expect(init.exe).toBe('/sbin/init')
    expect(init.ppid).toBe(0)
    expect(init.tty).toBeNull()
    expect([...init.context.descriptors.keys()].sort()).toEqual([0, 1, 2])
    const row = (await ps()).find(entry => entry.pid === 1)
    expect(row).toMatchObject({ ppid: 0, command: 'init' })
    expect((await ps()).filter(entry => entry.pid === 1)).toHaveLength(1) // no ghost row for its context
  })

  it('started crond as its child, in its own process group', async () => {
    const crond = (await ps()).find(entry => entry.command === 'crond')
    expect(crond?.ppid).toBe(1)
  })

  it('keeps the daemons it starts off the terminal', async () => {
    const crond = [...processes.values()].find(proc => proc.comm === 'crond' && proc.code === undefined)!
    expect(crond.tty).toBeNull()
    expect(kernel.terminal.zfsTty?.foreground?.pid).not.toBe(crond.pid)
  })

  it('finished boot: the sysinit entry ran before the kernel went on', async () => {
    expect(kernel.state).toBe('running')
    // /boot/init's script ran as a child of init and was reaped: none left over
    expect(kernel.init.process!.children.size).toBeGreaterThan(0)
    expect([...kernel.init.process!.children].every(child => child.code === undefined)).toBe(true)
  })

  it('restarts crond when it dies', async () => {
    const before = (await ps()).find(entry => entry.command === 'crond')!
    await kernel.shell.execute(`kill -9 ${before.pid}`)
    const back = await until(async () => (await ps()).some(entry => entry.command === 'crond' && entry.pid !== before.pid))
    expect(back, JSON.stringify(await ps()) + ' | init children: ' + [...kernel.init.process!.children].map(c => c.pid + ':' + c.code).join(',')).toBe(true)
    expect((await ps()).some(entry => entry.pid === before.pid)).toBe(false)
  }, 15_000)

  it('leaves no unowned context behind for the log lines and the restarts it causes', async () => {
    const unowned = () => [...boundContexts.keys()].filter(id => !processes.has(id))
    const before = unowned()
    for (let i = 0; i < 5; i++) kernel.log.info(`context leak probe ${i}`)
    const crond = (await ps()).find(entry => entry.command === 'crond')!
    await kernel.shell.execute(`kill -9 ${crond.pid}`)
    expect(await until(async () => (await ps()).some(entry => entry.command === 'crond' && entry.pid !== crond.pid))).toBe(true)
    await sleep(200)
    expect(unowned()).toEqual(before)
  }, 15_000)

  it('a login and a logout on a shell leave no context behind', async () => {
    const unowned = () => [...boundContexts.keys()].filter(id => !processes.has(id))
    const cred = { uid: 0, gid: 0, suid: 0, sgid: 0, euid: 0, egid: 0, groups: [] }
    const user = kernel.users.all.get(0)!
    await kernel.startSession(kernel.shell, user, cred)
    const before = unowned()
    for (let i = 0; i < 3; i++) {
      await kernel.startSession(kernel.shell, user, cred)
      await kernel.endLogin(0)
    }
    // the shell's own current context is one of them, so the count is what must hold
    expect(unowned().length).toBe(before.length)
  }, 15_000)

  it('does not die to SIGKILL, SIGINT or SIGQUIT (SIGTERM, SIGUSR1 and SIGUSR2 take the system down: init-shutdown.test.ts)', async () => {
    await kernel.shell.execute('kill -9 1')
    await kernel.shell.execute('kill -2 1')
    await kernel.shell.execute('kill -3 1')
    await sleep(100)
    expect(processes.get(1)!.code).toBeUndefined()
    expect((await ps()).some(entry => entry.pid === 1)).toBe(true)
  })

  it('reads /etc/inittab again on SIGHUP and starts a new respawn entry', async () => {
    const inittab = await kernel.filesystem.fs.readFile('/etc/inittab', 'utf-8')
    await kernel.filesystem.fs.writeFile('/etc/inittab', inittab + '::respawn:/bin/sleep 3000\n')
    expect((await ps()).some(entry => entry.command.startsWith('sleep'))).toBe(false)
    await kernel.shell.execute('kill -HUP 1')
    expect(await until(async () => (await ps()).some(entry => entry.command.startsWith('sleep') && entry.ppid === 1))).toBe(true)
    // restore, so later tests see the default
    await kernel.filesystem.fs.writeFile('/etc/inittab', inittab)
  })

  it('makes every command a child of init, in its own process group, and reaps it when it exits', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/who.js', [
      'const { getpid, getppid, getpgid, write } = globalThis.ecmaosSyscalls',
      'write(1, new TextEncoder().encode([getpid(), getppid(), await getpgid(0)].join(" ") + "\\n"))'
    ].join('\n'), { mode: 0o755 })
    await kernel.shell.execute('/tmp/who.js > /tmp/who.out')
    const [pid, ppid, pgid] = (await kernel.filesystem.fs.readFile('/tmp/who.out', 'utf-8')).trim().split(' ').map(Number)
    expect(ppid).toBe(1)
    expect(pgid).toBe(pid)
    expect(await until(async () => !processes.has(pid!))).toBe(true) // reaped by init, not left a zombie
    expect([...kernel.init.process!.children].some(child => child.pid === pid)).toBe(false)
  })

  it('leaves no zombies behind a burst of commands', async () => {
    for (let i = 0; i < 5; i++) await kernel.shell.execute('true')
    expect(await until(async () => [...kernel.init.process!.children].every(child => child.code === undefined))).toBe(true)
  })

  it('gives the kernel shell its own process as a child of init, so $PPID is 1', async () => {
    expect(kernel.shell.process.parent?.pid).toBe(1)
    await kernel.shell.execute('echo $PPID > /tmp/ppid.out')
    expect((await kernel.filesystem.fs.readFile('/tmp/ppid.out', 'utf-8')).trim()).toBe('1')
  })

  it('keeps its calls for init: another program gets EPERM', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/not-init.js', [
      'const { custom, write } = globalThis.ecmaosSyscalls',
      "const out = []",
      "for (const call of [['init_wait', 0], ['init_booted'], ['init_script', '/boot/init', '[]']]) {",
      "  try { await custom(...call); out.push(call[0] + ' ok') } catch (e) { out.push(call[0] + ' ' + (e.code || e.message)) }",
      '}',
      "write(1, new TextEncoder().encode(out.join('\\n') + '\\n'))"
    ].join('\n'), { mode: 0o755 })
    await kernel.shell.execute('/tmp/not-init.js > /tmp/not-init.out')
    const out = await kernel.filesystem.fs.readFile('/tmp/not-init.out', 'utf-8')
    expect(out.trim().split('\n')).toEqual(['init_wait EPERM', 'init_booted EPERM', 'init_script EPERM'])
  })
})
