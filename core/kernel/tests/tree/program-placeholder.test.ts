import { beforeAll, describe, expect, it } from 'vitest'

import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { PLACEHOLDER, PROGRAM_WAITER, programWaiterSource } from '#lib/programs.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `/bin/<name>` while its program downloads in the background: see `stagePrograms` in `lib/programs.ts`. */
describe('a program that is still being installed', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const land = (ms: number, write: () => Promise<void>) => new Promise<void>(resolve => setTimeout(() => { void write().then(resolve) }, ms))

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    await fs().mkdir('/usr/libexec/ecmaos', { recursive: true })
    await fs().writeFile(PROGRAM_WAITER, programWaiterSource, { mode: 0o755 })
  })

  it('waits for the program to land, then runs it with the same arguments and ends with its status', async () => {
    await fs().writeFile('/bin/later', PLACEHOLDER, { mode: 0o755 })
    const run = kernel.shell.execute('later one two > /tmp/later.out; echo "status $?" >> /tmp/later.out')
    // the "program" that arrives: echo, under the placeholder's name
    await land(300, async () => fs().writeFile('/bin/later', await fs().readFile('/bin/echo', 'utf-8'), { mode: 0o755 }))
    expect(await run).toBe(0)
    expect(await fs().readFile('/tmp/later.out', 'utf-8')).toBe('one two\nstatus 0\n')
  }, 30_000)

  it('runs a WebAssembly program that lands at once, while the placeholder is starting', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const jq = new Uint8Array(readFileSync(`${process.cwd()}/../utils/programs/jq.wasm`))
    for (const ms of [0, 5, 50]) {
      await fs().writeFile('/bin/soon', PLACEHOLDER, { mode: 0o755 })
      const run = kernel.shell.execute('soon --version > /tmp/soon.out 2>&1')
      await land(ms, () => fs().writeFile('/bin/soon', jq, { mode: 0o755 }))
      expect(await run).toBe(0)
      expect(await fs().readFile('/tmp/soon.out', 'utf-8')).toMatch(/^jq-/)
    }
  }, 60_000)

  // the placeholder waits for the program as a shell waits for a foreground job: a ^C is for the program, which may
  // take it and go on (Vim does), and the run ends when the program does
  it('leaves ^C to the program it runs', async () => {
    await fs().writeFile('/bin/patient', PLACEHOLDER, { mode: 0o755 })
    const run = kernel.shell.execute('patient > /tmp/patient.out')
    // a program that takes SIGINT and goes on
    await land(100, () => fs().writeFile('/bin/patient', [
      'const { exit, writeAll, onSignal } = globalThis.ecmaosSyscalls',
      'onSignal(2, () => {})',
      'writeAll(1, new TextEncoder().encode("started\\n"))',
      'await new Promise(resolve => setTimeout(resolve, 1500))',
      'writeAll(1, new TextEncoder().encode("went on\\n"))',
      'exit(0)'
    ].join('\n'), { mode: 0o755 }))
    const deadline = Date.now() + 20_000
    while (!(await fs().readFile('/tmp/patient.out', 'utf-8').catch(() => '')).includes('started')) {
      if (Date.now() > deadline) throw new Error('the program did not start')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    // what the terminal's ^C reaches: the placeholder and the program
    const waiter = [...processes.values()].find(proc => proc.comm === 'wait-for-program' && proc.code === undefined)!
    const program = [...waiter.children].find(proc => proc.code === undefined)!
    waiter.kill(2)
    program.kill(2)
    expect(await run).toBe(0)
    expect(await fs().readFile('/tmp/patient.out', 'utf-8')).toBe('started\nwent on\n')
  }, 30_000)

  it('says so and fails when the install does, as the placeholder is taken away', async () => {
    await fs().writeFile('/bin/never', PLACEHOLDER, { mode: 0o755 })
    const run = kernel.shell.execute('never 2> /tmp/never.err')
    await land(300, () => fs().unlink('/bin/never'))
    expect(await run).toBe(127)
    expect(await fs().readFile('/tmp/never.err', 'utf-8')).toBe('never: could not be installed\n')
  }, 30_000)
})
