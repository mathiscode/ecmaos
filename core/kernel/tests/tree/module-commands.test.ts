import { beforeAll, describe, expect, it } from 'vitest'
import { bindContext } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { canRunProgramsAsUser } from '#lib/process-credentials.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const hello = `/* ecmaos-module
 * name=hello
 * version=1.0.0
 * license=GPL-2.0-only
 * description=Says hello
 * parm=times:number:How often
 */
export default {
  init(ctx) {
    ctx.log.info('hello, ' + ctx.param('times'))
    ctx.export('hello.times', ctx.param('times'))
  }
}
`

describe('insmod, rmmod and modinfo', () => {
  let kernel: Kernel
  const sh = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    const read = async (file: string) => await kernel.filesystem.fs.exists(file) ? kernel.filesystem.fs.readFile(file, 'utf-8') : ''
    // what the command wrote to stdout and to stderr, together
    return { code, out: (await read('/tmp/out')) + (await read('/tmp/err')) }
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
    await kernel.filesystem.fs.mkdir('/lib/modules', { recursive: true })
    await kernel.filesystem.fs.writeFile('/lib/modules/hello.ko.mjs', hello)
    await kernel.users.add({ username: 'alice', password: 'wonder', home: '/home/alice', shell: '/bin/ecmash' })
  })

  /** Runs `command` as alice; the shell's credentials are what a program started from it inherits */
  const asAlice = async (command: string) => {
    const alice = [...(kernel.users.all as Map<number, { uid: number, gid: number, username: string }>).values()].find(user => user.username === 'alice')!
    const root = { ...kernel.shell.credentials }
    const rootContext = kernel.shell.context
    const cred = { uid: alice.uid, gid: alice.gid, suid: alice.uid, sgid: alice.gid, euid: alice.uid, egid: alice.gid, groups: [alice.gid] }
    kernel.shell.credentials = cred
    kernel.shell.context = bindContext({ root: '/', pwd: '/', credentials: cred })
    try {
      const code = await kernel.shell.execute(`${command} > /tmp/alice-out 2> /tmp/alice-err`)
      const read = (name: string) => kernel.filesystem.fs.readFile(`/tmp/alice-${name}`, 'utf-8').catch(() => '')
      return { code, out: (await read('out')) + (await read('err')) }
    } finally {
      kernel.shell.credentials = root
      kernel.shell.context = rootContext
    }
  }

  it('loads a module with a parameter, shows it everywhere, and unloads it', async () => {
    expect((await sh('insmod /lib/modules/hello.ko.mjs times=3')).code).toBe(0)

    expect((await sh('cat /proc/modules')).out).toMatch(/^hello [1-9]\d* 0 - Live 0x0+ \(OE\)$/m)

    expect((await sh('cat /sys/module/hello/parameters/times')).out.trim()).toBe('3')
    expect((await sh('cat /sys/module/hello/taint')).out.trim()).toBe('OE')
    expect((await sh('cat /proc/kallsyms')).out).toMatch(/hello\.times\t\[hello\]/)
    expect((await sh('cat /proc/sys/kernel/tainted')).out.trim()).toBe(String((1 << 12) | (1 << 13)))

    expect((await sh('rmmod hello')).code).toBe(0)
    expect((await sh('cat /proc/modules')).out).not.toMatch(/^hello/m)
    expect((await sh('cat /proc/kallsyms')).out.trim()).toBe('')
  })

  it('modinfo reads the file, and the loaded module', async () => {
    const info = await sh('modinfo /lib/modules/hello.ko.mjs')
    expect(info.code).toBe(0)
    expect(info.out).toContain('name:           hello')
    expect(info.out).toContain('license:        GPL-2.0-only')
    expect(info.out).toContain('kind:           js (runs in the kernel, unconfined)')
    expect(info.out).toContain('parm:           times:How often (number)')
  })

  it('says why it cannot load or unload', async () => {
    expect(await sh('insmod /lib/modules/missing.ko.mjs')).toMatchObject({ code: 1 })
    await kernel.filesystem.fs.writeFile('/tmp/plain.mjs', 'export default {}')
    expect((await sh('insmod /tmp/plain.mjs')).out).toContain('no ecmaos-module header')
    expect((await sh('rmmod nothing')).out).toContain('module nothing is not currently loaded')
    expect((await sh('insmod /lib/modules/hello.ko.mjs times=x')).out).toContain('wants a number')
  })

  it('lets anyone list and read, but only root load or unload', async () => {
    if (!await canRunProgramsAsUser(kernel.filesystem.fs)) return // every program runs as root on this machine
    await kernel.filesystem.fs.chmod('/tmp', 0o1777)
    expect((await asAlice('cat /proc/modules')).code).toBe(0)
    expect((await asAlice('modinfo /lib/modules/hello.ko.mjs')).code).toBe(0)
    const load = await asAlice('insmod /lib/modules/hello.ko.mjs')
    expect(load.code).toBe(1)
    expect(load.out).toContain('Operation not permitted')
    expect((await asAlice('rmmod hello')).out).toContain('Operation not permitted')
  })

  it('sign-module makes a key and signs; a trusted signature removes the E taint, and enforcement refuses the rest', async () => {
    await kernel.filesystem.fs.mkdir('/root/keys', { recursive: true })
    expect((await sh('cd /root/keys && sign-module --genkey release')).code).toBe(0)
    expect((await kernel.filesystem.fs.stat('/root/keys/release.key')).mode & 0o777).toBe(0o600)

    expect((await sh('cd /root/keys && sign-module -k release.key -s release -o /lib/modules/hello-signed.ko.mjs /lib/modules/hello.ko.mjs')).code).toBe(0)
    const signed = await kernel.filesystem.fs.readFile('/lib/modules/hello-signed.ko.mjs', 'utf-8')
    expect(signed).toMatch(/\/\* ecmaos-module-signature\n \* signer=release\n \* key_id=[0-9a-f]{16}\n \* sig=\S+\n \*\/\n$/)
    // the module is the same module with a trailer
    await kernel.filesystem.fs.writeFile('/lib/modules/hello-signed.ko.mjs', signed.replace('name=hello', 'name=hello-signed'))
    // no key is trusted yet, so the signature is only unknown
    expect((await sh('modinfo /lib/modules/hello-signed.ko.mjs')).out).toContain('sig_status:     no trusted key')

    // sign again, after the rename, and trust the key
    expect((await sh('cd /root/keys && sign-module -k release.key /lib/modules/hello-signed.ko.mjs')).code).toBe(0)
    await kernel.filesystem.fs.mkdir('/etc/modules-keys', { recursive: true })
    expect((await sh('cp /root/keys/release.pub /etc/modules-keys/release.pub')).code).toBe(0)

    const info = await sh('modinfo /lib/modules/hello-signed.ko.mjs')
    expect(info.out).toContain('sig_id:         Ed25519')
    expect(info.out).toContain('signer:         release')
    expect(info.out).toContain('sig_status:     valid (trusted key release)')

    expect((await sh('insmod /lib/modules/hello-signed.ko.mjs')).code).toBe(0)
    expect((await sh('cat /sys/module/hello-signed/taint')).out.trim()).toBe('O')
    expect((await sh('cat /proc/sys/kernel/tainted')).out.trim()).toBe(String(1 << 12))
    expect((await sh('rmmod hello-signed')).code).toBe(0)

    // a byte changed after signing is refused
    await kernel.filesystem.fs.writeFile('/lib/modules/hello-signed.ko.mjs', (await kernel.filesystem.fs.readFile('/lib/modules/hello-signed.ko.mjs', 'utf-8')).replace('Says hello', 'Says hullo'))
    expect((await sh('insmod /lib/modules/hello-signed.ko.mjs')).out).toContain('signature does not match')

    // enforcement: unsigned is refused, and it cannot be turned off
    expect(await kernel.shell.execute('echo 1 > /proc/sys/kernel/module_sig_enforce')).toBe(0)
    await kernel.shell.execute('echo 0 > /proc/sys/kernel/module_sig_enforce')
    expect((await sh('insmod /lib/modules/hello.ko.mjs')).out).toContain('module is not signed')
    expect((await sh('cat /proc/sys/kernel/module_sig_enforce')).out.trim()).toBe('1')
  })

  it('stops loading for good once modules_disabled is 1', async () => {
    expect(await kernel.shell.execute('echo 1 > /proc/sys/kernel/modules_disabled')).toBe(0)
    await kernel.shell.execute('echo 0 > /proc/sys/kernel/modules_disabled')
    expect((await sh('cat /proc/sys/kernel/modules_disabled')).out.trim()).toBe('1')
    expect((await sh('insmod /lib/modules/hello.ko.mjs')).out).toContain('module loading is disabled')
  })
})
