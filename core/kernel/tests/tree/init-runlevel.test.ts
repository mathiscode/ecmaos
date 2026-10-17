import { beforeAll, describe, expect, it } from 'vitest'

import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `telinit` and `runlevel` against the real init: entries come and go with the level. */
describe('runlevels', () => {
  let kernel: Kernel
  let n = 0

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const run = async (command: string) => {
    const file = `/tmp/runlevel-${n++}.out`
    const code = await kernel.shell.execute(`${command} > ${file} 2>&1`)
    return { code, out: await kernel.filesystem.fs.readFile(file, 'utf-8') }
  }
  const running = async () => [...processes.values()].filter(proc => proc.comm === 'sleep' && proc.code === undefined).map(proc => (proc.argv ?? []).join(' '))
  const until = async (check: () => Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await check()) return true; await sleep(50) }
    return false
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  it('starts the entries of the initdefault level, then follows telinit', async () => {
    expect((await run('runlevel')).out).toBe('unknown\n')
    await kernel.filesystem.fs.writeFile('/etc/inittab', [
      '::sysinit:/boot/init', '::respawn:/bin/crond',
      'x:5:initdefault:',
      'a:5:respawn:/bin/sleep 3001',
      'b:2:respawn:/bin/sleep 3002',
      ''
    ].join('\n'))
    await run('kill -HUP 1')
    expect(await until(async () => (await running()).some(row => row.includes('3001')))).toBe(true)
    expect((await running()).some(row => row.includes('3002'))).toBe(false)
    expect((await run('runlevel')).out).toBe('N 5\n')

    expect((await run('telinit 2')).code).toBe(0)
    expect(await until(async () => (await running()).some(row => row.includes('3002')))).toBe(true)
    expect(await until(async () => !(await running()).some(row => row.includes('3001')))).toBe(true)
    expect((await run('runlevel')).out).toBe('N 2\n')
    expect(await kernel.filesystem.fs.readFile('/run/runlevel', 'utf-8')).toBe('2\n')

    expect((await run('telinit 5')).code).toBe(0)
    expect(await until(async () => (await running()).some(row => row.includes('3001')))).toBe(true)
    expect(await until(async () => !(await running()).some(row => row.includes('3002')))).toBe(true)
    expect((await run('telinit')).code).toBe(1)
    await run('telinit 9')
    await sleep(300)
    expect((await running()).some(row => row.includes('3001') || row.includes('3002'))).toBe(false)
  }, 60_000)
})
