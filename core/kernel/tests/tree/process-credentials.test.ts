import { beforeAll, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { canRunProgramsAsUser } from '#lib/process-credentials.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('programs run as the user who started them', () => {
  let kernel: Kernel
  let alice: { uid: number, gid: number }
  let gateOpen = false
  const internals = () => kernel as unknown as { _programsRunAsUser: boolean }

  const asAlice = async (run: () => Promise<void>) => {
    const root = { ...kernel.shell.credentials }
    const rootContext = kernel.shell.context
    const cred = { uid: alice.uid, gid: alice.gid, suid: alice.uid, sgid: alice.gid, euid: alice.uid, egid: alice.gid, groups: [alice.gid] }
    kernel.shell.credentials = cred
    kernel.shell.context = bindContext({ root: '/', pwd: '/', credentials: cred })
    kernel.shell.cwd = '/home/alice'
    try { await run() } finally {
      kernel.shell.credentials = root
      kernel.shell.context = rootContext
      kernel.shell.cwd = '/'
    }
  }
  const status = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /home/alice/out 2> /home/alice/err`)
    const read = (name: string) => kernel.filesystem.fs.readFile(`/home/alice/${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    // a boot-tail sudo() can swap shell credentials for a moment
    await new Promise(r => setTimeout(r, 1500))
    await kernel.users.add({ username: 'alice', password: 'wonder', home: '/home/alice', shell: '/bin/ecmash' })
    alice = [...(kernel.users.all as Map<number, { uid: number, gid: number, username: string }>).values()].find(u => u.username === 'alice')!
    gateOpen = await canRunProgramsAsUser(kernel.filesystem.fs)
  }, 60000)

  it('the boot probe agrees with a direct check and leaves nothing behind', async () => {
    expect(internals()._programsRunAsUser).toBe(gateOpen)
    expect(await kernel.filesystem.fs.exists('/run/.credentials-probe')).toBe(false)
  })

  it('a root shell still starts root programs', async () => {
    await kernel.shell.execute('cat /proc/self/status > /tmp/root-status')
    expect(await kernel.filesystem.fs.readFile('/tmp/root-status', 'utf-8')).toMatch(/Uid:\t0\t0\t0\t0/)
  })

  it('a user shell starts programs as that user when the installed zenfs allows it', async () => {
    await asAlice(async () => {
      const result = await status('cat /proc/self/status')
      expect(result.code).toBe(0)
      const want = gateOpen ? alice.uid : 0
      expect(result.out).toMatch(new RegExp(`Uid:\\t${want}\\t${want}\\t${want}\\t${want}`))
    })
  }, 30000)

  it('file permissions apply to that user', async () => {
    if (!gateOpen) return
    await asAlice(async () => {
      expect((await status('cat /etc/shadow')).code).not.toBe(0)
      expect((await status('cat /etc/passwd')).code).toBe(0)
      expect((await status('touch /home/alice/mine')).code).toBe(0)
      expect((await kernel.filesystem.fs.stat('/home/alice/mine')).uid).toBe(alice.uid)
    })
  }, 30000)

  it('a user cannot change system directories but can use /tmp', async () => {
    if (!gateOpen) return
    await asAlice(async () => {
      expect((await status('touch /etc/nope')).code).not.toBe(0)
      expect((await status('touch /bin/nope')).code).not.toBe(0)
      expect((await status('mkdir /newdir')).code).not.toBe(0)
      expect((await status('touch /tmp/alice-file')).code).toBe(0)
    })
    expect(await kernel.filesystem.fs.exists('/etc/nope')).toBe(false)
    expect(await kernel.filesystem.fs.exists('/newdir')).toBe(false)
  }, 30000)

  it('a user cannot remove or replace a file another user left in /tmp', async () => {
    if (!gateOpen) return
    await kernel.filesystem.fs.writeFile('/tmp/roots-file', 'mine', { mode: 0o666 })
    await asAlice(async () => {
      expect((await status('rm /tmp/roots-file')).code).not.toBe(0)
    })
    expect(await kernel.filesystem.fs.exists('/tmp/roots-file')).toBe(true)
  }, 30000)

  it('with the gate closed every program still runs, as root', async () => {
    internals()._programsRunAsUser = false
    try {
      await asAlice(async () => {
        const result = await status('cat /proc/self/status')
        expect(result.code).toBe(0)
        expect(result.out).toMatch(/Uid:\t0\t0\t0\t0/)
        expect((await status('cat /etc/passwd')).code).toBe(0)
      })
    } finally {
      internals()._programsRunAsUser = gateOpen
    }
  }, 30000)

  it('a child spawned by a user program keeps that user', async () => {
    if (!gateOpen) return
    await asAlice(async () => {
      const result = await status('ecmash -c "cat /proc/self/status"')
      expect(result.code).toBe(0)
      expect(result.out).toMatch(new RegExp(`Uid:\\t${alice.uid}\\t`))
    })
  }, 30000)
})
