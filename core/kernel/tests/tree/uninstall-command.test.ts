import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `uninstall` migrated off the legacy shim onto real execve (`src/bin/commands/uninstall.mjs`) --
 * unlike `install`, it only ever reads a directory, reads/parses one `package.json`, and
 * unlinks/removes real files, all plain filesystem syscalls, no kernel-only state or custom syscall
 * needed. See `install-command.test.ts` for the sibling `install` real-tarball test and why `install`
 * itself stays on the legacy shim (recursive `shell.execute()` for pre/postinstall scripts and
 * dependencies -- a worker can't drive its own parent shell).
 */
describe('uninstall command: real execve, plain filesystem syscalls only', () => {
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

  it('is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/uninstall', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('removes an installed package directory and unlinks its bin symlink', async () => {
    const extractPath = '/usr/lib/fake-pkg/1.2.3'
    await kernel.filesystem.fs.mkdir(extractPath, { mode: 0o755, recursive: true })
    await kernel.filesystem.fs.writeFile(`${extractPath}/package.json`, JSON.stringify({
      name: 'fake-pkg', version: '1.2.3', bin: { 'fake-pkg': 'bin/cli.js' }
    }))
    await kernel.filesystem.fs.mkdir('/usr/bin', { recursive: true }).catch(() => {})
    await kernel.filesystem.fs.symlink(`${extractPath}/bin/cli.js`, '/usr/bin/fake-pkg')

    const code = await kernel.shell.execute('uninstall fake-pkg')
    expect(code).toBe(0)

    expect(await kernel.filesystem.fs.exists(extractPath)).toBe(false)
    expect(await kernel.filesystem.fs.exists('/usr/lib/fake-pkg')).toBe(false)
    expect(await kernel.filesystem.fs.exists('/usr/bin/fake-pkg')).toBe(false)
  })

  it('reports an error for a package that is not installed', async () => {
    const code = await kernel.shell.execute('uninstall not-a-real-package')
    expect(code).toBe(1)
  })

  it('uninstalling one version leaves other installed versions intact', async () => {
    await kernel.filesystem.fs.mkdir('/usr/lib/multi-pkg/1.0.0', { mode: 0o755, recursive: true })
    await kernel.filesystem.fs.mkdir('/usr/lib/multi-pkg/2.0.0', { mode: 0o755, recursive: true })

    const code = await kernel.shell.execute('uninstall multi-pkg@1.0.0')
    expect(code).toBe(0)

    expect(await kernel.filesystem.fs.exists('/usr/lib/multi-pkg/1.0.0')).toBe(false)
    expect(await kernel.filesystem.fs.exists('/usr/lib/multi-pkg/2.0.0')).toBe(true)
  })
})
