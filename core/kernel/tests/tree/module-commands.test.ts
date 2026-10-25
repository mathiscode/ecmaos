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

  describe('depmod and modprobe', () => {
    const mod = (name: string, extra: string[] = []) => `/* ecmaos-module\n * name=${name}\n${extra.map(line => ` * ${line}\n`).join('')} */\nexport default { init(ctx) { ctx.log.info('${name}') } }\n`
    const dir = () => `/lib/modules/${kernel.version}`
    const loadedNames = async () => [...(await sh('cat /proc/modules')).out.matchAll(/^(\S+) /gm)].map(match => match[1])
    const config = async (text: string) => {
      await kernel.filesystem.fs.mkdir('/etc/modprobe.d', { recursive: true })
      await kernel.filesystem.fs.writeFile('/etc/modprobe.d/test.conf', text)
    }

    beforeAll(async () => {
      await kernel.filesystem.fs.mkdir(`${dir()}/extra`, { recursive: true })
      await kernel.filesystem.fs.writeFile(`${dir()}/extra/base.ko.mjs`, mod('base'))
      await kernel.filesystem.fs.writeFile(`${dir()}/mid.ko.mjs`, mod('mid', ['depends=base']))
      await kernel.filesystem.fs.writeFile(`${dir()}/top.ko.mjs`, mod('top', ['depends=mid', 'alias=fs-top', 'parm=greeting:string:The greeting']))
      await kernel.filesystem.fs.writeFile(`${dir()}/solo.ko.mjs`, mod('solo'))
      await kernel.filesystem.fs.writeFile(`${dir()}/odd.ko.mjs`, mod('other'))
    })

    it('depmod writes modules.dep and modules.alias, and warns about a file whose name is not the module', async () => {
      const result = await sh('depmod')
      expect(result.code).toBe(0)
      expect(result.out).toContain('odd.ko.mjs: the file is named odd but the module says it is other')
      const dep = await kernel.filesystem.fs.readFile(`${dir()}/modules.dep`, 'utf-8')
      expect(dep).toContain('top.ko.mjs: mid.ko.mjs extra/base.ko.mjs\n')
      expect(dep).toContain('mid.ko.mjs: extra/base.ko.mjs\n')
      expect(dep).toContain('extra/base.ko.mjs:\n')
      expect(await kernel.filesystem.fs.readFile(`${dir()}/modules.alias`, 'utf-8')).toBe('alias fs-top top\n')
    })

    it('modprobe loads a module through its alias with what it needs, applies modprobe.d options, and -r unloads the lot', async () => {
      await config('# comment\noptions top greeting=hi\n')
      expect((await sh('modprobe -n fs-top')).out).toMatch(/insmod .*\/extra\/base\.ko\.mjs\ninsmod .*\/mid\.ko\.mjs\ninsmod .*\/top\.ko\.mjs greeting=hi/)
      expect(await loadedNames()).not.toContain('top')

      expect((await sh('modprobe fs-top')).code).toBe(0)
      expect(await loadedNames()).toEqual(expect.arrayContaining(['base', 'mid', 'top']))
      expect((await sh('cat /sys/module/top/parameters/greeting')).out.trim()).toBe('hi')
      expect((await sh('rmmod base')).out).toContain('in use')
      expect((await sh('modprobe top')).code).toBe(0) // already there

      expect((await sh('modprobe -r fs-top')).code).toBe(0)
      expect(await loadedNames()).not.toEqual(expect.arrayContaining(['base']))
      expect(await loadedNames()).not.toContain('mid')
    })

    it('a blacklisted module does not load for an alias, softdep loads its friends, install runs a command', async () => {
      await config('blacklist top\n')
      expect((await sh('modprobe fs-top')).code).toBe(0)
      expect(await loadedNames()).not.toContain('top')
      expect((await sh('modprobe top')).code).toBe(0)
      expect(await loadedNames()).toContain('top')
      expect((await sh('modprobe -r top')).code).toBe(0)

      await config('softdep solo post: base\n')
      expect((await sh('modprobe solo')).code).toBe(0)
      expect(await loadedNames()).toEqual(expect.arrayContaining(['solo', 'base']))
      expect((await sh('modprobe -r solo')).code).toBe(0)
      expect((await sh('rmmod base')).code).toBe(0)

      await config('install solo echo ran-install > /tmp/install-ran\n')
      expect((await sh('modprobe solo')).code).toBe(0)
      expect(await loadedNames()).not.toContain('solo')
      expect((await kernel.filesystem.fs.readFile('/tmp/install-ran', 'utf-8')).trim()).toBe('ran-install')
      expect((await sh('modprobe --ignore-install solo')).code).toBe(0)
      expect(await loadedNames()).toContain('solo')
      expect((await sh('rmmod solo')).code).toBe(0)
    })

    it('says when a module is not there, and /etc/modules-load.d loads names at boot and reports the ones that fail', async () => {
      await config('')
      expect((await sh('modprobe nothing-here')).out).toContain('Module nothing-here not found in directory')
      await kernel.filesystem.fs.mkdir('/etc/modules-load.d', { recursive: true })
      await kernel.filesystem.fs.writeFile('/etc/modules-load.d/test.conf', '# at boot\nsolo\nmissing\n')
      const reports: string[] = []
      await kernel.modprobe.loadAtBoot(message => reports.push(message))
      expect(await loadedNames()).toContain('solo')
      expect(reports).toEqual([expect.stringContaining('modprobe missing: Module missing not found')])
      expect((await sh('rmmod solo')).code).toBe(0)
      await kernel.filesystem.fs.writeFile('/etc/modules-load.d/test.conf', '')
    })
  })

  describe('hooks that add files', () => {
    const files = `/* ecmaos-module
 * name=files
 * license=GPL-2.0-only
 */
export default {
  async init(ctx) {
    let count = 7
    const ref = { value: 5 }
    ctx.proc('files', { show: () => 'proc ok\\n' })
    ctx.proc('filesdir/stats', {
      show: () => 'count=' + count + '\\n',
      store: value => { if (!/^\\d+$/.test(value.trim())) throw new Error('not a number'); count = Number(value) }
    })
    ctx.sys('files/deep', { answer: { show: () => '42\\n' } })
    ctx.debugfs.file('hello', { read: () => 'debug ok\\n' })
    ctx.debugfs.value('deep/level', 'u32', ref)
    ctx.configfs.subsystem({ name: 'files', attributes: { version: { show: () => '1\\n' } }, make: name => ({ attributes: { size: { show: () => name.length + '\\n' } } }) })
    await ctx.command('files-hello', "const { write, exit } = globalThis.ecmaosSyscalls; write(1, new TextEncoder().encode('from files\\\\n')); exit(0)")
  }
}
`
    const clash = `/* ecmaos-module
 * name=clash
 */
export default { init(ctx) { ctx.proc('clash', { show: () => 'x\\n' }); ctx.debugfs.file('f', { read: () => 'x\\n' }); ctx.proc('version', { show: () => 'x\\n' }) } }
`
    const exists = async (path: string) => (await sh(`ls ${path}`)).code === 0

    beforeAll(async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/files.ko.mjs', files)
      await kernel.filesystem.fs.writeFile('/lib/modules/clash.ko.mjs', clash)
    })

    it('adds /proc, /sys, debugfs, configfs and a command, and rmmod takes every one of them away', async () => {
      expect((await sh('insmod /lib/modules/files.ko.mjs')).code).toBe(0)

      expect((await sh('cat /proc/files')).out).toBe('proc ok\n')
      expect((await sh('cat /proc/filesdir/stats')).out).toBe('count=7\n')
      expect((await sh('cat /sys/kernel/files/deep/answer')).out).toBe('42\n')
      expect((await sh('cat /sys/kernel/debug/files/hello')).out).toBe('debug ok\n')
      expect((await sh('cat /sys/kernel/debug/files/deep/level')).out).toBe('5\n')
      expect(await kernel.shell.execute('echo 9 > /sys/kernel/debug/files/deep/level')).toBe(0)
      expect((await sh('cat /sys/kernel/debug/files/deep/level')).out).toBe('9\n')
      expect((await sh('cat /sys/kernel/config/files/version')).out).toBe('1\n')
      expect((await sh('mkdir /sys/kernel/config/files/box')).code).toBe(0)
      expect((await sh('cat /sys/kernel/config/files/box/size')).out).toBe('3\n')
      expect((await sh('files-hello')).out).toBe('from files\n')

      // a store that throws is logged, and the file keeps working
      expect(await kernel.shell.execute('echo 12 > /proc/filesdir/stats')).toBe(0)
      expect(await kernel.shell.execute('echo nope > /proc/filesdir/stats')).toBe(0)
      expect((await sh('cat /proc/filesdir/stats')).out).toBe('count=12\n')

      expect((await sh('rmmod files')).code).toBe(0)
      for (const path of ['/proc/files', '/proc/filesdir', '/sys/kernel/files', '/sys/kernel/debug/files', '/sys/kernel/config/files', '/usr/bin/files-hello']) {
        expect(await exists(path), path).toBe(false)
      }
      expect((await sh('files-hello')).code).not.toBe(0)

      // and it loads again, since nothing was left in the way
      expect((await sh('insmod /lib/modules/files.ko.mjs')).code).toBe(0)
      expect((await sh('cat /proc/files')).out).toBe('proc ok\n')
      expect((await sh('rmmod files')).code).toBe(0)
    })

    it('a module that cannot get a name it asks for does not load and leaves nothing behind', async () => {
      const result = await sh('insmod /lib/modules/clash.ko.mjs')
      expect(result.code).not.toBe(0)
      expect(result.out).toContain('/proc/version exists')
      expect(await exists('/proc/clash')).toBe(false)
      expect(await exists('/sys/kernel/debug/clash')).toBe(false)
      expect((await sh('cat /proc/version')).out).toContain('ecmaOS version')
    })

    it('will not put a command where one is already', async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/shadow.ko.mjs', "/* ecmaos-module\n * name=shadow\n */\nexport default { init: ctx => ctx.command('ls', 'x') }\n")
      const result = await sh('insmod /lib/modules/shadow.ko.mjs')
      expect(result.code).not.toBe(0)
      expect(result.out).toContain('exists')
    })
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
