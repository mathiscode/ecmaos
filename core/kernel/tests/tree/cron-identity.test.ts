import { beforeAll, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { canRunProgramsAsUser } from '#lib/process-credentials.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `crond` runs a job as the account whose crontab it came from, in a shell with no terminal, instead of in
 * whichever shell the kernel's first terminal happens to hold. Running as anyone else needs programs to run
 * as their user, which the published @zenfs/core cannot do; there a job runs as root, as everything does.
 */
describe('cron jobs run as their owner', () => {
  let kernel: Kernel
  let alice: { uid: number, gid: number }
  let bob: { uid: number, gid: number }
  let gateOpen = false

  const asUser = async (user: { uid: number, gid: number }, home: string, run: () => Promise<void>) => {
    const root = { ...kernel.shell.credentials }
    const rootContext = kernel.shell.context
    const cred = { uid: user.uid, gid: user.gid, suid: user.uid, sgid: user.gid, euid: user.uid, egid: user.gid, groups: [user.gid] }
    kernel.shell.credentials = cred
    kernel.shell.context = bindContext({ root: '/', pwd: '/', credentials: cred })
    kernel.shell.cwd = home
    try { await run() } finally {
      kernel.shell.credentials = root
      kernel.shell.context = rootContext
      kernel.shell.cwd = '/'
    }
  }
  const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf-8').catch(() => undefined)
  const uidLine = (uid: number) => new RegExp(`Uid:\\t${uid}\\t${uid}\\t${uid}\\t${uid}`)

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    // a boot-tail sudo() can swap shell credentials for a moment
    await new Promise(r => setTimeout(r, 1500))
    await kernel.users.add({ username: 'alice', password: 'wonder', home: '/home/alice', shell: '/bin/ecmash' })
    await kernel.users.add({ username: 'bob', password: 'builder', home: '/home/bob', shell: '/bin/ecmash' })
    const named = (name: string) => [...(kernel.users.all as Map<number, { uid: number, gid: number, username: string }>).values()].find(u => u.username === name)!
    alice = named('alice')
    bob = named('bob')
    gateOpen = await canRunProgramsAsUser(kernel.filesystem.fs)
  }, 60000)

  it('--run starts the job as that user, in their home, with their environment', async () => {
    const want = gateOpen ? alice.uid : 0
    expect(await kernel.shell.execute("crond --run alice 'cat /proc/self/status > /tmp/cron-status; pwd > /tmp/cron-cwd; echo $USER:$LOGNAME:$HOME > /tmp/cron-env'")).toBe(0)
    expect(await read('/tmp/cron-status')).toMatch(uidLine(want))
    expect(await read('/tmp/cron-cwd')).toBe('/home/alice\n')
    expect(await read('/tmp/cron-env')).toBe('alice:alice:/home/alice\n')
  }, 60000)

  it('--run gives the status of the job, and refuses an unknown user', async () => {
    expect(await kernel.shell.execute('crond --run root "exit 3"')).toBe(3)
    expect(await kernel.shell.execute('crond --run nobody-here id 2> /dev/null')).toBe(1)
  }, 60000)

  it('a job has no terminal', async () => {
    await kernel.shell.execute('crond --run root "tty > /tmp/cron-tty"')
    expect(await read('/tmp/cron-tty')).not.toMatch(/xterm|tty\d/)
  }, 60000)

  it('a user may not start a job as someone else', async () => {
    if (!gateOpen) return
    await asUser(alice, '/home/alice', async () => {
      expect(await kernel.shell.execute('crond --run bob "touch /tmp/cron-by-alice" 2> /dev/null')).not.toBe(0)
    })
    expect(await kernel.filesystem.fs.exists('/tmp/cron-by-alice')).toBe(false)
  }, 60000)

  it('the daemon runs a user\'s crontab as that user when its minute comes, and ignores a file someone else owns', async () => {
    if (!gateOpen) return
    const fs = kernel.filesystem.fs
    for (const [user, name] of [[alice, 'alice'], [bob, 'bob']] as const) {
      await fs.mkdir(`/home/${name}/.config`, { recursive: true })
      await fs.chown(`/home/${name}`, user.uid, user.gid)
      await fs.chown(`/home/${name}/.config`, user.uid, user.gid)
      await fs.writeFile(`/home/${name}/.config/crontab`, `* * * * * cat /proc/self/status > /home/${name}/cron-ran\n`)
    }
    await fs.chown('/home/alice/.config/crontab', alice.uid, alice.gid)
    // bob's file belongs to root's other user: not bob's, so it must not run
    await fs.chown('/home/bob/.config/crontab', alice.uid, alice.gid)

    const start = Date.now()
    while (!await read('/home/alice/cron-ran') && Date.now() - start < 90000) await new Promise(r => setTimeout(r, 500))
    const ran = await read('/home/alice/cron-ran')
    expect(ran).toMatch(uidLine(alice.uid))
    expect((await fs.stat('/home/alice/cron-ran')).uid).toBe(alice.uid)
    expect(await fs.exists('/home/bob/cron-ran')).toBe(false)
  }, 120000)
})
