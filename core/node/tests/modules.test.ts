import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

// the file is made with printf: the header is one line a field
const file = String.raw`printf '/* ecmaos-module\n * name=hello\n * version=1.0.0\n * license=GPL-2.0-only\n * parm=times:number:How often\n */\nexport default { init(ctx) { ctx.export("hello.times", ctx.param("times")) } }\n' > /tmp/hello.ko.mjs`

describe.skipIf(!supported)('kernel modules on the Node host', () => {
  const session = new Session()

  beforeAll(async () => { await session.ready() })
  afterAll(async () => { await session.stop() })

  it('loads, lists, reads and unloads a module', async () => {
    await session.run(file)
    expect(await session.run('modinfo /tmp/hello.ko.mjs')).toContain('name:           hello')
    expect(await session.run('insmod /tmp/hello.ko.mjs times=2; echo exit $?')).toBe('exit 0')
    expect(await session.run('lsmod')).toMatch(/^hello +[1-9]\d* +0 *$/m)
    expect(await session.run('cat /sys/module/hello/parameters/times')).toBe('2')
    expect(await session.run('cat /proc/kallsyms')).toContain('hello.times')
    expect(await session.run('cat /proc/sys/kernel/tainted')).toBe(String((1 << 12) | (1 << 13)))
    expect(await session.run('rmmod hello; echo exit $?')).toBe('exit 0')
    expect(await session.run('lsmod')).not.toContain('hello')
  })

  it('a module signed by a trusted key loads without the E taint, and a changed one is refused', async () => {
    await session.run(file)
    await session.run('mkdir -p /etc/modules-keys && sign-module --genkey release')
    // the line is long enough that the terminal wraps its echo, so only the end of the output is compared
    expect(await session.run('sign-module -k release.key -o /tmp/s.ko.mjs /tmp/hello.ko.mjs; echo exit $?')).toMatch(/exit 0$/)
    expect(await session.run('modinfo /tmp/s.ko.mjs')).toContain('sig_status:     no trusted key')
    await session.run('cp release.pub /etc/modules-keys/')
    expect(await session.run('modinfo /tmp/s.ko.mjs')).toContain('sig_status:     valid (trusted key release)')
    expect(await session.run('insmod /tmp/s.ko.mjs times=1; echo exit $?')).toBe('exit 0')
    expect(await session.run('cat /sys/module/hello/taint')).toBe('O')
    expect(await session.run('rmmod hello; echo exit $?')).toBe('exit 0')

    await session.run("sed 's/1.0.0/1.0.1/' /tmp/s.ko.mjs > /tmp/e.ko.mjs")
    expect(await session.run('insmod /tmp/e.ko.mjs; echo exit $?')).toContain('signature does not match')
  })

  it('depmod and modprobe load a module with what it needs, by alias, and -r unloads them', async () => {
    const make = (name: string, extra = '') => `printf '/* ecmaos-module\\n * name=${name}\\n${extra} */\\nexport default { init() {} }\\n' > $d/${name}.ko.mjs`
    await session.run('d=/lib/modules/$(uname -r); mkdir -p $d')
    await session.run(make('lib1'))
    await session.run(make('app1', ' * depends=lib1\\n * alias=fs-app1\\n'))
    expect(await session.run('depmod; echo exit $?')).toMatch(/exit 0$/)
    expect(await session.run('cat $d/modules.dep')).toContain('app1.ko.mjs: lib1.ko.mjs')
    expect(await session.run('modprobe fs-app1; echo exit $?')).toMatch(/exit 0$/)
    const listed = await session.run('lsmod')
    expect(listed).toMatch(/^lib1 /m)
    expect(listed).toMatch(/^app1 /m)
    expect(await session.run('modprobe -r app1; echo exit $?')).toMatch(/exit 0$/)
    expect(await session.run('lsmod')).not.toMatch(/^(lib1|app1) /m)
  })

  it('a module adds files to /proc, /sys, debugfs and configfs and a command, and rmmod takes them away', async () => {
    await session.run(String.raw`printf '/* ecmaos-module\n * name=extras\n */\nexport default { async init(ctx) { ctx.proc("extras", { show: () => "ok\\n" }); ctx.sys("extras", { a: { show: () => "1\\n" } }); ctx.debugfs.file("d", { read: () => "2\\n" }); ctx.configfs.subsystem({ name: "extras", make: () => ({}) }); await ctx.command("extras-cmd", "globalThis.ecmaosSyscalls.exit(0)") } }\n' > /tmp/extras.ko.mjs`)
    expect(await session.run('insmod /tmp/extras.ko.mjs; echo exit $?')).toBe('exit 0')
    expect(await session.run('cat /proc/extras')).toBe('ok')
    expect(await session.run('cat /sys/kernel/extras/a')).toBe('1')
    expect(await session.run('cat /sys/kernel/debug/extras/d')).toBe('2')
    expect(await session.run('ls /sys/kernel/config')).toContain('extras')
    expect(await session.run('extras-cmd; echo exit $?')).toBe('exit 0')
    expect(await session.run('rmmod extras; echo exit $?')).toBe('exit 0')
    expect(await session.run('ls /proc/extras /sys/kernel/extras /sys/kernel/debug/extras /usr/bin/extras-cmd; echo exit $?')).toMatch(/exit [1-9]\d*$/)
    expect(await session.run('ls /sys/kernel/config')).not.toContain('extras')
  })

  it('a module adds a filesystem type, a program format, a syscall and a policy, and request_module loads one by alias', async () => {
    await session.run('d=/lib/modules/$(uname -r); mkdir -p $d')
    await session.run(String.raw`printf '/* ecmaos-module\n * name=fsx\n * alias=fs-fsx\n */\nexport default { init(ctx) { ctx.filesystem({ name: "fsx", backend: ctx.import("zenfs.core").InMemory }); ctx.syscall("fsx_ping", () => 9); ctx.binfmt({ name: "fsx", interpreter: "/bin/sh", matches: () => false }); ctx.syscallPolicy(() => undefined) } }\n' > $d/fsx.ko.mjs`)
    expect(await session.run('depmod; echo exit $?')).toMatch(/exit 0$/)
    expect(await session.run('cat /proc/filesystems')).not.toContain('fsx')
    expect(await session.run('mount -t fsx /mnt/fsx; echo exit $?')).toMatch(/Mounted fsx filesystem at \/mnt\/fsx\s+exit 0$/)
    expect(await session.run('cat /proc/filesystems')).toContain('fsx')
    expect(await session.run('rmmod fsx; echo exit $?')).toContain('1 fsx filesystem is mounted')
    expect(await session.run('umount /mnt/fsx; rmmod fsx; echo exit $?')).toMatch(/exit 0$/)
    expect(await session.run('cat /proc/filesystems')).not.toContain('fsx')
  })

  it('mount -t of a type nobody has fetches the module that has it from the catalog the first time', async () => {
    expect(await session.run('ls /lib/modules/$(uname -r)/kernel/archives.ko.mjs; echo exit $?')).toMatch(/exit [1-9]\d*$/)
    // the file is not there, but the type is: the module had to be fetched and loaded to get as far as saying so
    expect(await session.run('mount -t iso /tmp/nothing.iso /mnt/iso')).toContain('file not found: /tmp/nothing.iso')
    expect(await session.run('lsmod')).toMatch(/^archives /m)
    expect(await session.run('cat /proc/filesystems')).toMatch(/\biso\b/)
    expect(await session.run('ls /lib/modules/$(uname -r)/kernel/archives.ko.mjs; echo exit $?')).toMatch(/exit 0$/)
  })

  // the nightly compiler with the wasip3 library is a separate install (see the examples' rust-toolchain.toml)
  const toolchain = (() => {
    try {
      return execFileSync('rustup', ['target', 'list', '--installed', '--toolchain', 'nightly-2026-10-25'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('wasm32-wasip3')
    } catch {
      return false
    }
  })()

  describe.skipIf(!toolchain)('WebAssembly modules (Rust, WASI 0.3)', () => {
    let server: Server
    let url = ''

    beforeAll(async () => {
      const kernel = path.resolve(import.meta.dirname, '../../kernel')
      const folder = mkdtempSync(path.join(tmpdir(), 'ecmaos-rust-'))
      for (const name of ['wasm-hello-rust', 'wasm-ramfs-rust']) {
        execFileSync(process.execPath, ['scripts/build-wasm-rust.mjs', `examples/${name}`, path.join(folder, `${name.replaceAll('-', '_')}.ko.wasm`)], { cwd: kernel, stdio: 'ignore' })
      }
      server = createServer((request, response) => {
        try { response.end(readFileSync(path.join(folder, path.basename(request.url ?? '')))) } catch { response.statusCode = 404; response.end() }
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }, 480000)

    afterAll(() => { server?.close() })

    it('a component loads on the host, answers /proc and a syscall, and unloads', async () => {
      expect(await session.run(`fetch -o /tmp/hello.ko.wasm ${url}/wasm_hello_rust.ko.wasm; echo exit $?`)).toMatch(/exit 0$/)
      expect(await session.run('modinfo /tmp/hello.ko.wasm')).toContain('kind:           wasm')
      expect(await session.run('insmod /tmp/hello.ko.wasm greeting=hej; echo exit $?', 60_000)).toBe('exit 0')
      expect(await session.run('cat /proc/wasm_hello_rust')).toBe('hej from Rust')
      expect(await session.run('rmmod wasm_hello_rust; echo exit $?')).toBe('exit 0')
      expect(await session.run('ls /proc/wasm_hello_rust; echo exit $?')).toMatch(/exit [1-9]\d*$/)
    }, 120000)

    it('a filesystem in Rust mounts, holds a file, and cannot be unloaded while mounted', async () => {
      expect(await session.run(`fetch -o /tmp/ramfs.ko.wasm ${url}/wasm_ramfs_rust.ko.wasm; echo exit $?`)).toMatch(/exit 0$/)
      expect(await session.run('insmod /tmp/ramfs.ko.wasm; echo exit $?', 60_000)).toBe('exit 0')
      expect(await session.run('cat /proc/filesystems')).toContain('wasmram')
      expect(await session.run('mkdir -p /mnt/wasmram; mount -t wasmram /mnt/wasmram; echo exit $?')).toMatch(/exit 0$/)
      await session.run('echo kept > /mnt/wasmram/a.txt')
      await session.run('mv /mnt/wasmram/a.txt /mnt/wasmram/b.txt')
      expect(await session.run('cat /mnt/wasmram/b.txt')).toBe('kept')
      expect(await session.run('rmmod wasm_ramfs_rust; echo exit $?')).toContain('in use')
      expect(await session.run('umount /mnt/wasmram; rmmod wasm_ramfs_rust; echo exit $?')).toMatch(/exit 0$/)
    }, 120000)
  })
})
