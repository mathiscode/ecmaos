import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    // what the kernel provides stays; what the module exported is gone
    const symbols = (await sh('cat /proc/kallsyms')).out
    expect(symbols).toContain('T zenfs.core')
    expect(symbols).not.toContain('hello.times')
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

  describe('filesystem types', () => {
    const memfs = `/* ecmaos-module
 * name=memfs
 * license=GPL-2.0-only
 */
export default {
  init(ctx) {
    const { InMemory } = ctx.import('zenfs.core')
    ctx.filesystem({ name: 'scratchfs', backend: InMemory })
  }
}
`
    beforeAll(async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/memfs.ko.mjs', memfs)
    })

    it('lists the built-in types, takes a module type, mounts it, and refuses to unload it while it is mounted', async () => {
      expect((await sh('cat /proc/filesystems')).out).toMatch(/nodev\tmemory\n/)
      expect((await sh('cat /proc/filesystems')).out).not.toContain('scratchfs')
      expect((await sh('mount -t scratchfs /mnt/scratch')).out).toContain("unknown filesystem type 'scratchfs'")

      expect((await sh('insmod /lib/modules/memfs.ko.mjs')).code).toBe(0)
      expect((await sh('cat /proc/filesystems')).out).toMatch(/nodev\tscratchfs\n/)
      expect((await sh('mount -t scratchfs /mnt/scratch')).out).toContain('Mounted scratchfs filesystem at /mnt/scratch')
      expect((await sh('echo hi > /mnt/scratch/f && cat /mnt/scratch/f')).out).toBe('hi\n')
      expect((await sh('mount -t scratchfs /mnt/other src')).out).toContain('does not require a source')

      const busy = await sh('rmmod memfs')
      expect(busy.code).not.toBe(0)
      expect(busy.out).toContain('1 scratchfs filesystem is mounted')

      expect((await sh('umount /mnt/scratch')).code).toBe(0)
      expect((await sh('rmmod memfs')).code).toBe(0)
      expect((await sh('cat /proc/filesystems')).out).not.toContain('scratchfs')
      expect((await sh('mount -t scratchfs /mnt/scratch')).out).toContain("unknown filesystem type")
    })

    it('will not take a name a type already has', async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/dup.ko.mjs', "/* ecmaos-module\n * name=dup\n */\nexport default { init(ctx) { ctx.filesystem({ name: 'memory', backend: ctx.import('zenfs.core').InMemory }) } }\n")
      const result = await sh('insmod /lib/modules/dup.ko.mjs')
      expect(result.code).not.toBe(0)
      expect(result.out).toContain('filesystem type memory exists')
    })
  })

  describe('program formats', () => {
    const fmt = `/* ecmaos-module
 * name=binfmt_demo
 * license=GPL-2.0-only
 */
export default {
  async init(ctx) {
    await ctx.command('demo-run', "const { argv, read, open, close, write, exit, O_RDONLY } = globalThis.ecmaosSyscalls; const fd = open(argv[1], O_RDONLY); const buf = new Uint8Array(64); const n = read(fd, buf, -1); close(fd); write(1, new TextEncoder().encode('demo ran ' + new TextDecoder().decode(buf.subarray(5, n)).trim() + '\\\\n')); exit(0)")
    ctx.binfmt({ name: 'demo', interpreter: '/usr/bin/demo-run', matches: ({ magic }) => new TextDecoder().decode(magic.subarray(0, 5)) === 'DEMO:' })
  }
}
`
    beforeAll(async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/binfmt_demo.ko.mjs', fmt)
      await kernel.filesystem.fs.writeFile('/tmp/prog.demo', 'DEMO:hello\n', { mode: 0o755 })
    })

    it('runs a file of a format a module added, and stops when the module goes', async () => {
      expect((await sh('/tmp/prog.demo')).code).not.toBe(0)
      expect((await sh('insmod /lib/modules/binfmt_demo.ko.mjs')).code).toBe(0)
      const ran = await sh('/tmp/prog.demo')
      expect(ran.out).toContain('demo ran hello')
      expect(ran.code).toBe(0)
      expect((await sh('rmmod binfmt_demo')).code).toBe(0)
      expect((await sh('/tmp/prog.demo')).code).not.toBe(0)
    })

    it('will not take the name of a format that exists', async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/binfmt_dup.ko.mjs', "/* ecmaos-module\n * name=binfmt_dup\n */\nexport default { init(ctx) { ctx.binfmt({ name: 'script', interpreter: '/bin/sh', matches: () => false }) } }\n")
      const result = await sh('insmod /lib/modules/binfmt_dup.ko.mjs')
      expect(result.code).not.toBe(0)
      expect(result.out).toContain('binfmt script exists')
    })
  })

  describe('syscalls', () => {
    const sys = `/* ecmaos-module
 * name=sys_demo
 * license=GPL-2.0-only
 */
export default {
  init(ctx) {
    ctx.syscall('demo_add', (call, a, b) => a + b)
    ctx.syscall('demo_secret', () => 7)
    ctx.syscallPolicy(call => call.syscall === 'demo_secret' ? false : undefined)
    ctx.syscallPolicy(() => { throw new Error('broken policy') })
  }
}
`
    beforeAll(async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/sys_demo.ko.mjs', sys)
      await kernel.filesystem.fs.writeFile('/usr/bin/demo-call', "#!/usr/bin/env node\nconst { argv, custom, write, exit } = globalThis.ecmaosSyscalls; let out; try { out = String(await custom(argv[1], ...argv.slice(2).map(Number))) } catch (error) { out = 'threw ' + (error.code ?? error.message) } write(1, new TextEncoder().encode(out + '\\n')); exit(0)\n", { mode: 0o755 })
    })

    it('adds a syscall and a policy, and takes both away on rmmod', async () => {
      expect((await sh('demo-call demo_add 2 3')).out).toBe('threw ENOSYS\n')
      expect((await sh('insmod /lib/modules/sys_demo.ko.mjs')).code).toBe(0)
      expect((await sh('demo-call demo_add 2 3')).out).toBe('5\n')
      // the policy refuses one syscall, and a policy that throws does not lock anything
      expect((await sh('demo-call demo_secret')).out).toBe('threw EPERM\n')
      expect((await sh('rmmod sys_demo')).code).toBe(0)
      expect((await sh('demo-call demo_add 2 3')).out).toBe('threw ENOSYS\n')
    })

    it('will not take the name of a syscall that exists', async () => {
      await kernel.filesystem.fs.writeFile('/lib/modules/sys_dup.ko.mjs', "/* ecmaos-module\n * name=sys_dup\n */\nexport default { init(ctx) { ctx.syscall('module_ctl', () => 0) } }\n")
      const result = await sh('insmod /lib/modules/sys_dup.ko.mjs')
      expect(result.code).not.toBe(0)
      expect(result.out).toContain('syscall module_ctl exists')
    })
  })

  describe('request_module', () => {
    const dir = () => `/lib/modules/${kernel.version}`
    beforeAll(async () => {
      await kernel.filesystem.fs.mkdir(dir(), { recursive: true })
      await kernel.filesystem.fs.writeFile(`${dir()}/autofs.ko.mjs`, "/* ecmaos-module\n * name=autofs\n * alias=fs-autofs\n */\nexport default { init(ctx) { ctx.filesystem({ name: 'autofs', backend: ctx.import('zenfs.core').InMemory }) } }\n")
      await kernel.filesystem.fs.writeFile(`${dir()}/binfmt_auto.ko.mjs`, "/* ecmaos-module\n * name=binfmt_auto\n * alias=binfmt-auto\n */\nexport default { async init(ctx) { await ctx.command('auto-run', \"globalThis.ecmaosSyscalls.write(1, new TextEncoder().encode('auto ran\\\\n')); globalThis.ecmaosSyscalls.exit(0)\"); ctx.binfmt({ name: 'auto', interpreter: '/usr/bin/auto-run', matches: ({ magic }) => new TextDecoder().decode(magic.subarray(0, 5)) === 'AUTO:' }) } }\n")
      await kernel.filesystem.fs.writeFile('/tmp/prog.auto', 'AUTO:x\n', { mode: 0o755 })
      expect((await sh('depmod')).code).toBe(0)
    })

    it('mount -t loads the module with the alias fs-TYPE, and an unknown type still fails', async () => {
      expect((await sh('cat /proc/modules')).out).not.toContain('autofs')
      expect((await sh('mount -t autofs /mnt/auto')).out).toContain('Mounted autofs filesystem at /mnt/auto')
      expect((await sh('cat /proc/modules')).out).toContain('autofs')
      expect((await sh('mount -t nonesuch /mnt/none')).out).toContain("unknown filesystem type 'nonesuch'")
      expect((await sh('umount /mnt/auto')).code).toBe(0)
      expect((await sh('rmmod autofs')).code).toBe(0)
    })

    it('running a file of an unknown format loads the module with the alias binfmt-EXTENSION', async () => {
      expect((await sh('cat /proc/modules')).out).not.toContain('binfmt_auto')
      const ran = await sh('/tmp/prog.auto')
      expect(ran.out).toContain('auto ran')
      expect((await sh('cat /proc/modules')).out).toContain('binfmt_auto')
      expect((await sh('rmmod binfmt_auto')).code).toBe(0)
    })

    it('requestModule loads by alias for the kernel itself', async () => {
      expect(await kernel.requestModule('fs-autofs')).toBe(true)
      expect((await sh('rmmod autofs')).code).toBe(0)
    })
  })

  describe('in-tree modules', () => {
    // a mount that failed still loaded the module, and an unsigned module taints the kernel for the signing test after
    afterAll(async () => { await sh('umount /mnt/bad'); await sh('rmmod archives') })

    beforeAll(async () => {
      // the modules the site serves, built the way a release builds them
      const { execFileSync } = (process as unknown as { getBuiltinModule: (id: string) => typeof import('node:child_process') }).getBuiltinModule('node:child_process')
      execFileSync(process.execPath, ['scripts/build-modules.mjs'], { cwd: (process as unknown as { getBuiltinModule: (id: string) => typeof import('node:path') }).getBuiltinModule('node:path').resolve(import.meta.dirname, '../..') })
      // a zip with one file in it, made with the library the module bundles
      const { zipSync, strToU8 } = await import('fflate')
      await kernel.filesystem.fs.writeFile('/tmp/test.zip', zipSync({ 'hello.txt': strToU8('from the zip\n') }))
    })

    it('mount -t zip fetches the zip module the first time, loads it, and the files are there', async () => {
      expect(await kernel.filesystem.fs.exists(`/lib/modules/${kernel.version}/kernel/archives.ko.mjs`)).toBe(false)
      expect((await sh('cat /proc/modules')).out).not.toMatch(/^archives /m)
      expect((await sh('mount -t zip /tmp/test.zip /mnt/zip')).out).toContain('Mounted zip filesystem from /tmp/test.zip to /mnt/zip')
      expect(await kernel.filesystem.fs.exists(`/lib/modules/${kernel.version}/kernel/archives.ko.mjs`)).toBe(true)
      expect((await sh('cat /mnt/zip/hello.txt')).out).toBe('from the zip\n')
      expect((await sh('cat /proc/modules')).out).toMatch(/^archives /m)
      expect((await sh('cat /proc/filesystems')).out).toContain('zip')
      expect((await sh('modinfo archives')).out).toContain('license:        LGPL-3.0-or-later')

      // in use while mounted, and free after
      expect((await sh('rmmod archives')).out).toContain('1 zip filesystem is mounted')
      expect((await sh('umount /mnt/zip')).code).toBe(0)
      expect((await sh('rmmod archives')).code).toBe(0)

      // it stays on disk, so the next mount needs no download
      expect((await sh('mount -t zip /tmp/test.zip /mnt/zip2')).out).toContain('Mounted zip filesystem')
      expect((await sh('umount /mnt/zip2')).code).toBe(0)
      expect((await sh('rmmod archives')).code).toBe(0)
    })

    it('says what the zip type needs, and what is wrong with a file that is not one', async () => {
      expect((await sh('mount -t zip /mnt/nope')).out).toContain('zip filesystem requires a source')
      await kernel.filesystem.fs.writeFile('/tmp/bad.zip', 'not a zip')
      const bad = await sh('mount -t zip /tmp/bad.zip /mnt/bad')
      expect(bad.code).not.toBe(0)
    })

    it('a build with the release key signs the modules, and a kernel that trusts that key loads one with no E taint', async () => {
      const builtin = <T>(id: string) => (process as unknown as { getBuiltinModule: (id: string) => T }).getBuiltinModule(id)
      const fsx = builtin<typeof import('node:fs')>('node:fs')
      const pathx = builtin<typeof import('node:path')>('node:path')
      const osx = builtin<typeof import('node:os')>('node:os')
      const cp = builtin<typeof import('node:child_process')>('node:child_process')
      const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'ecmaos-key-'))
      const cwd = pathx.resolve(import.meta.dirname, '../..')
      cp.execFileSync(process.execPath, ['scripts/module-key.mjs', dir], { cwd })
      cp.execFileSync(process.execPath, ['scripts/build-modules.mjs', pathx.join(dir, 'out')], { cwd, env: { ...process.env, ECMAOS_MODULE_KEY: pathx.join(dir, 'ecmaos.key') } })
      const catalog = JSON.parse(fsx.readFileSync(pathx.join(dir, 'out', 'index.json'), 'utf8'))
      expect(catalog.modules.cloud.signed).toBe(true)

      await kernel.filesystem.fs.mkdir('/etc/modules-keys', { recursive: true })
      await kernel.filesystem.fs.writeFile('/etc/modules-keys/testrelease.pub', fsx.readFileSync(pathx.join(dir, 'ecmaos.pub'), 'utf8'))
      await kernel.filesystem.fs.writeFile('/tmp/cloud.ko.mjs', fsx.readFileSync(pathx.join(dir, 'out', 'cloud.ko.mjs'), 'utf8'))
      expect((await sh('modinfo /tmp/cloud.ko.mjs')).out).toContain('sig_status:     valid (trusted key testrelease)')
      expect((await sh('insmod /tmp/cloud.ko.mjs')).code).toBe(0)
      expect((await sh('cat /sys/module/cloud/taint')).out).toBe('O\n')
      expect((await sh('rmmod cloud')).code).toBe(0)
      await kernel.filesystem.fs.unlink('/etc/modules-keys/testrelease.pub')
    })

    it('boot writes the release key, so the modules the project signs are trusted', async () => {
      const pub = await kernel.filesystem.fs.readFile('/etc/modules-keys/ecmaos.pub', 'utf-8')
      expect(pub).toContain('1LgQZqClL+Wj85WkCDh8vg5SX7igrTzvPRtK24OZQoM=')
    })

    it('modules.builtin lists the types the kernel has, and modprobe has nothing to load for them', async () => {
      const text = await kernel.filesystem.fs.readFile(`/lib/modules/${kernel.version}/modules.builtin`, 'utf-8')
      expect(text).toContain('kernel/fs/memory.ko\n')
      expect(text).not.toContain('zip')
      expect((await sh('modprobe -n fs-memory')).out).toContain('builtin kernel/fs/memory.ko')
    })
  })

  describe('WebAssembly modules', () => {
    const builtin = <T>(id: string) => (process as unknown as { getBuiltinModule: (id: string) => T }).getBuiltinModule(id)
    const dir = () => `/lib/modules/${kernel.version}`

    beforeAll(async () => {
      // a JavaScript module componentized with jco, packed with its modinfo
      const cwd = builtin<typeof import('node:path')>('node:path').resolve(import.meta.dirname, '../..')
      const out = builtin<typeof import('node:path')>('node:path').join(builtin<typeof import('node:fs')>('node:fs').mkdtempSync(builtin<typeof import('node:path')>('node:path').join(builtin<typeof import('node:os')>('node:os').tmpdir(), 'ecmaos-wasm-')), 'wasm_hello.ko.wasm')
      builtin<typeof import('node:child_process')>('node:child_process').execFileSync(process.execPath, ['scripts/wasm-module.mjs', 'build', 'examples/wasm-hello/module.js', 'examples/wasm-hello/module.json', out], { cwd, stdio: 'ignore' })
      await kernel.filesystem.fs.mkdir(dir(), { recursive: true })
      await kernel.filesystem.fs.writeFile(`${dir()}/wasm_hello.ko.wasm`, new Uint8Array(builtin<typeof import('node:fs')>('node:fs').readFileSync(out)))
      await kernel.filesystem.fs.writeFile('/usr/bin/wasm-call', "#!/usr/bin/env node\nconst { argv, custom, write, exit } = globalThis.ecmaosSyscalls; let out; try { out = String(await custom(argv[1], ...argv.slice(2).map(Number))) } catch (error) { out = 'threw ' + (error.code ?? error.message) } write(1, new TextEncoder().encode(out + '\\n')); exit(0)\n", { mode: 0o755 })
    }, 60000)

    it('modinfo reads the modinfo section without running the module', async () => {
      const result = await sh(`modinfo ${dir()}/wasm_hello.ko.wasm`)
      expect(result.out).toContain('name:           wasm_hello')
      expect(result.out).toContain('license:        MIT')
      expect(result.out).toContain('kind:           wasm (a sandboxed component')
      expect(result.out).toContain('parm:           greeting')
      expect((await sh('cat /proc/modules')).out).not.toContain('wasm_hello')
    })

    it('loads, adds its files, syscall, policy and program format, answers them, and takes them all away on rmmod', async () => {
      const loaded = await sh(`insmod ${dir()}/wasm_hello.ko.wasm greeting=hi`)
      expect(loaded.code, loaded.out).toBe(0)
      expect((await sh('cat /proc/modules')).out).toMatch(/^wasm_hello /m)

      expect((await sh('cat /proc/wasm_hello')).out).toBe('hi from WebAssembly\nnote: \n')
      expect(await kernel.shell.execute('echo remembered > /proc/wasm_hello')).toBe(0)
      expect((await sh('cat /proc/wasm_hello')).out).toBe('hi from WebAssembly\nnote: remembered\n')
      expect((await sh('cat /sys/kernel/wasm_hello/greeting')).out).toBe('hi\n')
      expect((await sh('cat /sys/kernel/wasm_hello/note')).out).toBe('remembered\n')
      // each read of the file runs the module (the size is worked out from the text too), so the count goes up by however many
      const first = Number((await sh('cat /sys/kernel/debug/wasm_hello/reads')).out)
      const second = Number((await sh('cat /sys/kernel/debug/wasm_hello/reads')).out)
      expect(first).toBeGreaterThan(0)
      expect(second).toBeGreaterThan(first)
      expect((await sh('wasm-call wasm_hello_add 2 3 4')).out).toBe('9\n')
      expect(kernel.moduleBinfmts.size).toBe(1)

      expect((await sh('rmmod wasm_hello')).code).toBe(0)
      for (const path of ['/proc/wasm_hello', '/sys/kernel/wasm_hello', '/sys/kernel/debug/wasm_hello']) expect((await sh(`ls ${path}`)).code, path).not.toBe(0)
      expect((await sh('wasm-call wasm_hello_add 2 3')).out).toBe('threw ENOSYS\n')
      expect(kernel.moduleBinfmts.size).toBe(0)
    }, 60000)

    it('depmod finds it and modprobe loads it by its alias', async () => {
      expect((await sh('depmod')).code).toBe(0)
      expect(await kernel.filesystem.fs.readFile(`${dir()}/modules.alias`, 'utf-8')).toContain('alias binfmt-hello wasm_hello')
      expect((await sh('modprobe binfmt-hello')).code).toBe(0)
      expect((await sh('cat /proc/wasm_hello')).out).toContain('from WebAssembly')
      expect((await sh('modprobe -r wasm_hello')).code).toBe(0)
    }, 60000)

    it('refuses the filesystem, the network and HTTP', async () => {
      const { denied } = await import('#lib/wasm-module.ts')
      expect(() => (denied('the network') as { connect(): void }).connect()).toThrow('the network is not available to a module')
      expect(() => new ((denied('the filesystem') as { Descriptor: new () => unknown }).Descriptor)()).toThrow('the filesystem is not available to a module')
    })

    it('a signature is one more section: a trusted one removes the E taint and a changed module is refused', async () => {
      expect((await sh('sign-module --genkey wasmkey')).code).toBe(0)
      await kernel.filesystem.fs.mkdir('/etc/modules-keys', { recursive: true })
      expect((await sh('cp wasmkey.pub /etc/modules-keys/')).code).toBe(0)
      const signed = await sh(`sign-module -k wasmkey.key -o /tmp/signed.ko.wasm ${dir()}/wasm_hello.ko.wasm`)
      expect(signed.code, signed.out).toBe(0)
      expect((await sh('modinfo /tmp/signed.ko.wasm')).out).toContain('sig_status:     valid (trusted key wasmkey)')
      expect((await sh('insmod /tmp/signed.ko.wasm')).code).toBe(0)
      expect((await sh('cat /sys/module/wasm_hello/taint')).out).toBe('O\n')
      expect((await sh('rmmod wasm_hello')).code).toBe(0)

      // one byte of the module changed under its signature
      const bytes = new Uint8Array(await kernel.filesystem.fs.readFile('/tmp/signed.ko.wasm'))
      bytes[bytes.length >> 1]! ^= 1
      await kernel.filesystem.fs.writeFile('/tmp/changed.ko.wasm', bytes)
      expect((await sh('insmod /tmp/changed.ko.wasm')).out).toContain('signature does not match')
      await kernel.filesystem.fs.unlink('/etc/modules-keys/wasmkey.pub')
    }, 120000)
  })

  describe('WebAssembly modules for WASI 0.3, written in Rust', () => {
    const builtin = <T>(id: string) => (process as unknown as { getBuiltinModule: (id: string) => T }).getBuiltinModule(id)
    const dir = () => `/lib/modules/${kernel.version}`
    const cwd = builtin<typeof import('node:path')>('node:path').resolve(import.meta.dirname, '../..')
    // the nightly compiler with the wasip3 library is a separate install (see examples/wasm-hello-rust/rust-toolchain.toml)
    const toolchain = (() => {
      try {
        const installed = builtin<typeof import('node:child_process')>('node:child_process').execFileSync('rustup', ['target', 'list', '--installed', '--toolchain', 'nightly-2026-10-25'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        return installed.includes('wasm32-wasip3')
      } catch {
        return false
      }
    })()

    beforeAll(async () => {
      if (!toolchain) return
      const { join } = builtin<typeof import('node:path')>('node:path')
      const out = join(builtin<typeof import('node:fs')>('node:fs').mkdtempSync(join(builtin<typeof import('node:os')>('node:os').tmpdir(), 'ecmaos-rust-')), 'wasm_hello_rust.ko.wasm')
      builtin<typeof import('node:child_process')>('node:child_process').execFileSync(process.execPath, ['scripts/build-wasm-rust.mjs', 'examples/wasm-hello-rust', out], { cwd, stdio: 'ignore' })
      await kernel.filesystem.fs.mkdir(dir(), { recursive: true })
      await kernel.filesystem.fs.writeFile(`${dir()}/wasm_hello_rust.ko.wasm`, new Uint8Array(builtin<typeof import('node:fs')>('node:fs').readFileSync(out)))
    }, 240000)

    it.skipIf(!toolchain)('a WASI 0.3 component loads, answers /proc and a syscall, and unloads', async () => {
      const loaded = await sh(`insmod ${dir()}/wasm_hello_rust.ko.wasm greeting=hej`)
      expect(loaded.code, loaded.out).toBe(0)
      expect((await sh('cat /proc/wasm_hello_rust')).out).toBe('hej from Rust\n')
      expect((await sh('wasm-call wasm_hello_rust_add 4 5')).out).toBe('9\n')
      expect((await sh('modinfo wasm_hello_rust')).out).toContain('kind:           wasm')
      expect((await sh('rmmod wasm_hello_rust')).code).toBe(0)
      expect((await sh('ls /proc/wasm_hello_rust')).code).not.toBe(0)
    }, 60000)
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
