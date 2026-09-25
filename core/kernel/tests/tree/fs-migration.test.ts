import { beforeAll, describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import {
  DEFAULT_BOOT_INIT,
  FS_VERSION_FILE,
  PREVIOUS_DEFAULT_BOOT_INITS,
  readFsVersion,
  removeStaleCommandStubs,
  runFsMigrations
} from '#lib/fs-migrations.ts'
import { KernelState } from '@ecmaos/types'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const quietLog = { info() {}, warn() {} }
const liveStubs = () => new Set(['true', 'false', 'test'])
const OLD_0X_BOOT_INIT = PREVIOUS_DEFAULT_BOOT_INITS[1]!

/**
 * Boots a kernel whose persisted root already holds what a 0.x install leaves behind: stubs for
 * in-process commands that no longer exist, the pilot programs, the 0.x (empty) default /boot/init,
 * and no version marker.
 *
 * The fixture is written the moment `filesystem.configure()` has mounted the root, which is exactly
 * the state a page load finds a persisted root in, before `boot()` runs its migrations. (A second
 * full boot in one test process isn't possible: mounts and /dev are module-global, and only a page
 * reload clears them.)
 */
async function bootOverOldFilesystem(): Promise<Kernel> {
  const kernel = new Kernel({
    credentials: { username: 'root', password: 'root' },
    dom: TestDomOptions,
    filesystem: DefaultFilesystemOptions,
    log: TestLogOptions
  })

  const configure = kernel.filesystem.configure.bind(kernel.filesystem)
  vi.spyOn(kernel.filesystem, 'configure').mockImplementation(async options => {
    await configure(options)
    const fs = kernel.filesystem.fs
    if (!await fs.exists('/bin')) await fs.mkdir('/bin')
    if (!await fs.exists('/boot')) await fs.mkdir('/boot')
    if (await fs.exists(FS_VERSION_FILE)) await fs.unlink(FS_VERSION_FILE)
    await fs.writeFile('/bin/load-crontab', '#!ecmaos:bin:command:load-crontab', { mode: 0o755 })
    await fs.writeFile('/bin/help', '#!ecmaos:bin:command:help', { mode: 0o755 })
    await fs.writeFile('/bin/true', '#!ecmaos:bin:command:true', { mode: 0o755 })
    await fs.writeFile('/bin/pilot-pwd.js', 'console.log("pilot")', { mode: 0o755 })
    await fs.writeFile('/bin/pilot-window.js', 'console.log("pilot")', { mode: 0o755 })
    await fs.writeFile('/boot/init', OLD_0X_BOOT_INIT)
  })

  await kernel.boot()
  return kernel
}

describe('boot over a persisted 0.x filesystem', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = await bootOverOldFilesystem()
  })

  it('boots to RUNNING and records the filesystem as migrated', async () => {
    expect(kernel.state).toBe(KernelState.RUNNING)
    expect(await readFsVersion(kernel.filesystem.fs)).toBe(1)
  })

  it('removes stale command stubs and the pilot programs, keeping the live stubs', async () => {
    const fs = kernel.filesystem.fs
    expect(await fs.exists('/bin/load-crontab')).toBe(false)
    expect(await fs.exists('/bin/help')).toBe(false)
    expect(await fs.exists('/bin/pilot-pwd.js')).toBe(false)
    expect(await fs.exists('/bin/pilot-window.js')).toBe(false)
    expect(await fs.readFile('/bin/true', 'utf8')).toBe('#!ecmaos:bin:command:true')
    expect(await kernel.shell.execute('true')).toBe(0)
  })

  it('replaces an untouched old default /boot/init with the current default', async () => {
    expect(await kernel.filesystem.fs.readFile('/boot/init', 'utf8')).toBe(DEFAULT_BOOT_INIT)
    expect(await kernel.filesystem.fs.exists('/boot/init.new')).toBe(false)
  })

  it('is idempotent: running the boot-time migration and command registration again changes nothing', async () => {
    const fs = kernel.filesystem.fs
    const binBefore = (await fs.readdir('/bin')).sort()

    expect(await runFsMigrations({ fs, log: quietLog, legacyCommandNames: liveStubs() })).toEqual([])
    await kernel.registerCommands()

    expect(await readFsVersion(fs)).toBe(1)
    expect((await fs.readdir('/bin')).sort()).toEqual(binBefore)
    expect(await fs.readFile('/boot/init', 'utf8')).toBe(DEFAULT_BOOT_INIT)
    expect(await fs.exists('/boot/init.new')).toBe(false)
  })

  it('registerCommands itself clears a stale stub, so one can never outlive its command', async () => {
    const fs = kernel.filesystem.fs
    await fs.writeFile('/bin/obsolete', '#!ecmaos:bin:command:obsolete', { mode: 0o755 })
    await kernel.registerCommands()
    expect(await fs.exists('/bin/obsolete')).toBe(false)
    expect(await fs.exists('/bin/test')).toBe(true)
  })

  it('keeps an edited /boot/init and writes the new default beside it', async () => {
    const fs = kernel.filesystem.fs
    const edited = '#!ecmaos:bin:script:init\n\necho my own boot\n'
    await fs.unlink(FS_VERSION_FILE)
    await fs.writeFile('/boot/init', edited)

    expect(await runFsMigrations({ fs, log: quietLog, legacyCommandNames: liveStubs() })).toEqual([1])
    expect(await fs.readFile('/boot/init', 'utf8')).toBe(edited)
    expect(await fs.readFile('/boot/init.new', 'utf8')).toBe(DEFAULT_BOOT_INIT)
  })

  it('removeStaleCommandStubs leaves real programs and the named stubs alone', async () => {
    const fs = kernel.filesystem.fs
    await fs.writeFile('/bin/gone', '#!ecmaos:bin:command:gone', { mode: 0o755 })
    expect(await removeStaleCommandStubs(fs, liveStubs())).toEqual(['gone'])
    expect(await fs.exists('/bin/echo')).toBe(true)
    expect(await fs.exists('/bin/test')).toBe(true)
  })
})
