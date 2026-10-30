import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The programs as packages against a real registry (Verdaccio), which is a long way from the fake server the other tests
 * use. Opt-in: start it and publish first, then run with its address.
 *
 *   node utils/apps-registry.mjs up && node utils/apps-registry.mjs publish vim lolcat
 *   ECMAOS_E2E_REGISTRY=http://localhost:4893 npx vitest run tests/tree/wasm-apps-registry.test.ts
 */
const registry = process.env['ECMAOS_E2E_REGISTRY'] ?? ''

describe.skipIf(!registry)('wasm programs from a local registry', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const run = async (command: string) => {
    await fs().unlink('/tmp/wr-out').catch(() => {})
    await fs().unlink('/tmp/wr-err').catch(() => {})
    const code = await kernel.shell.execute(`${command} > /tmp/wr-out 2> /tmp/wr-err`)
    const read = (name: string) => fs().readFile(`/tmp/wr-${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    // a newer index than the one built in, as `apt update` would fetch: the programs that moved
    await fs().mkdir('/var/lib/install', { recursive: true })
    const index = { schema: 1, common: { vim: { package: '@ecmaos-apps/vim', description: 'Vim' }, lolcat: { package: '@ecmaos-apps/lolcat', description: 'lolcat' } } }
    await fs().writeFile('/var/lib/install/package-index.json', JSON.stringify({ version: '9.9.9', index }))
  }, 60_000)

  afterAll(() => { kernel?.terminal?.dispose?.() })

  it('installs a copyleft program and points at its source package', async () => {
    const result = await run(`apt install -y vim --registry ${registry} --allow-unsigned`)
    expect(result.code, result.err).toBe(0)
    expect(result.out).toContain('apt source vim')
    expect(await fs().readlink('/usr/bin/vim')).toMatch(/vim\.wasm$/)
    expect((await fs().readdir('/usr/share/vim')).length).toBeGreaterThan(0)
    expect((await fs().readdir('/usr/share/licenses/vim')).length).toBeGreaterThan(0)
  }, 120_000)

  it('fetches the source of it: the upstream archive, the build recipe and the toolchain pins', async () => {
    await fs().mkdir('/tmp/work', { recursive: true })
    const result = await run(`cd /tmp/work && apt source vim --registry ${registry} --allow-unsigned`)
    expect(result.code, result.err).toBe(0)
    const directory = '/tmp/work/vim-9.1.0-ecmaos.1'
    expect(await fs().exists(`${directory}/sources/vim-9.1.0.tar.gz`)).toBe(true)
    expect(await fs().exists(`${directory}/build/build.sh`)).toBe(true)
    expect(await fs().exists(`${directory}/toolchain/wali-version`)).toBe(true)
  }, 120_000)

  it('has no source for a program that is not copyleft', async () => {
    const result = await run(`cd /tmp/work && apt source lolcat --registry ${registry} --allow-unsigned`)
    expect(result.code).toBe(100)
    expect(result.err).toContain('Unable to find a source package for lolcat')
  }, 60_000)
  // node utils/apps-registry.mjs publish bzip2 xz zstd lz4 group-compression
  it('installs a group whose members are prerelease builds on latest, and removing a member keeps it out', async () => {
    const group = await run(`install -g @ecmaos-apps/group-compression --registry ${registry} --allow-unsigned`)
    expect(group.code, group.err).toBe(0)
    for (const command of ['bzip2', 'xz', 'zstd', 'lz4']) expect(await fs().readlink(`/usr/bin/${command}`), command).toMatch(new RegExp(`${command}\\.wasm$`))
    // the aliases the kernel links are bins of the package now
    expect(await fs().readlink('/usr/bin/unxz')).toMatch(/xz\.wasm$/)

    expect((await run('install -g remove @ecmaos-apps/xz')).code).toBe(0)
    expect(await fs().exists('/usr/bin/xz')).toBe(false)
    expect(await fs().exists('/usr/bin/zstd')).toBe(true)
    expect(JSON.parse(await fs().readFile('/etc/ecmaos/profile.d/excluded.json', 'utf-8'))).toEqual(['@ecmaos-apps/xz'])
    expect((await run(`install -g @ecmaos-apps/group-compression --reinstall --registry ${registry} --allow-unsigned`)).code).toBe(0)
    expect(await fs().exists('/usr/bin/xz')).toBe(false)
    expect((await run(`install -g @ecmaos-apps/xz --registry ${registry} --allow-unsigned`)).code).toBe(0)
    expect(await fs().exists('/usr/bin/xz')).toBe(true)
  }, 180_000)
})
