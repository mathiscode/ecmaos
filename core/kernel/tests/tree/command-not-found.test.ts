import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { DEFAULT_SKEL } from '#lib/skel.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A command the system does not have is answered with the package that provides it, by the ecmaos shell, `ecmash` and
 * bash (through `command_not_found_handle`). The hint comes from the package index and the status stays 127.
 */
describe('command-not-found', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs

  const run = async (command: string) => {
    await fs().unlink('/tmp/cnf.err').catch(() => {})
    // a group, so the redirection covers the shell's own message as well
    const code = await kernel.shell.execute(`{ ${command}\n} 2> /tmp/cnf.err`)
    return { code, err: await fs().readFile('/tmp/cnf.err', 'utf-8').catch(() => '') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL })
    await kernel.boot()
    await kernel.whenProgramsReady()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    await fs().mkdir('/var/lib/install', { recursive: true })
    const index = {
      schema: 2,
      common: { zzfig: { package: '@ecmaos-apps/zzfig', description: 'a banner' }, zzxz: { package: '@ecmaos-apps/zzxz', description: 'a compressor' }, zzown: { provided: 'part of ecmaOS' }, zzgroup: { package: '@ecmaos-apps/group-zz', meta: true } },
      commands: { zzfig: 'zzfig', zzunxz: 'zzxz', zzxz: 'zzxz' }
    }
    await fs().writeFile('/var/lib/install/package-index.json', JSON.stringify({ version: '9.9.9', index }))
  }, 120_000)

  it('the ecmaos shell names the package after the usual message, and the status stays 127', async () => {
    const result = await run('zzfig')
    expect(result.code).toBe(127)
    expect(result.err).toContain('zzfig: command not found')
    expect(result.err).toContain("Command 'zzfig' not found, but can be installed with:")
    expect(result.err).toContain('install @ecmaos-apps/zzfig')
  }, 30_000)

  it('says nothing more for a command the index does not know, or that ecmaOS ships, or that is a group', async () => {
    for (const name of ['zznothing', 'zzown', 'zzgroup']) {
      const result = await run(name)
      expect(result.code).toBe(127)
      expect(result.err).toBe(`ecmaos: ${name}: command not found\n`)
      expect(result.err).not.toContain('can be installed')
    }
  }, 30_000)

  it('follows the command\'s 2> redirection', async () => {
    const result = await run('{ zzfig\n} 2> /dev/null')
    expect(result.code).toBe(127)
    expect(result.err).toBe('')
  }, 30_000)

  it('the program names the package an alias is part of', async () => {
    const result = await run('command-not-found zzunxz zznothing')
    expect(result.code).toBe(127)
    expect(result.err).toContain("Command 'zzunxz' not found, but it is part of 'zzxz', which can be installed with:")
    expect(result.err).toContain('install @ecmaos-apps/zzxz')
    expect(result.err).not.toContain('zznothing')
  }, 30_000)

  it('ecmash prints it for a script too', async () => {
    const result = await run('ecmash -c "zzfig; echo status=\\$?" > /tmp/cnf.out')
    expect(result.err).toContain('zzfig: command not found')
    expect(result.err).toContain('install @ecmaos-apps/zzfig')
    expect(await fs().readFile('/tmp/cnf.out', 'utf-8')).toBe('status=127\n')
  }, 60_000)

  it('bash calls the command_not_found_handle that ~/.bashrc defines', async () => {
    const handler = DEFAULT_SKEL['.bashrc']!.content.slice(DEFAULT_SKEL['.bashrc']!.content.indexOf('command_not_found_handle'))
    await fs().writeFile('/tmp/cnf.sh', `${handler}\nzzfig\necho status=$?\n`)
    const result = await run('bash /tmp/cnf.sh > /tmp/cnf.out')
    expect(result.err).toContain('zzfig: command not found')
    expect(result.err).toContain('install @ecmaos-apps/zzfig')
    expect(await fs().readFile('/tmp/cnf.out', 'utf-8')).toBe('status=127\n')
  }, 60_000)
})
