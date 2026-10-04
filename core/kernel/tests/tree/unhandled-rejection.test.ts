import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A program that makes an asynchronous syscall and does not await it can see the kernel's refusal come back as
 * a rejection nobody handles. That used to stop the worker without ending the process, so whatever waited for
 * it waited for ever (an `ecmash` script hung this way when it signalled a process group that was already gone).
 * The program loader now reports such a rejection on stderr and ends the process with status 1.
 */
describe('a rejection nobody handles ends the program instead of wedging it', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  const run = async (name: string, body: string) => {
    const file = `/tmp/${name}.js`
    await kernel.filesystem.fs.writeFile(file, `const s = globalThis.ecmaosSyscalls\n${body}`, { mode: 0o755 })
    const code = await Promise.race([
      kernel.shell.execute(`${file} 2> ${file}.err`),
      new Promise<string>(resolve => setTimeout(() => resolve('HANG'), 15000)),
    ])
    return { code, err: await kernel.filesystem.fs.readFile(`${file}.err`, 'utf-8').catch(() => '') }
  }

  it('reports it and exits 1', async () => {
    const result = await run('unhandled-a', "s.killpg(999999, 2)\nawait new Promise(resolve => setTimeout(resolve, 500))\ns.writeAll(1, new TextEncoder().encode('not reached\\n'))")
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/No such process/i)
  }, 30000)

  it('does not disturb a program that handles the refusal itself', async () => {
    const result = await run('unhandled-b', "try { await s.killpg(999999, 2) } catch (error) { s.writeAll(2, new TextEncoder().encode('handled:' + (error.code ?? error.message) + '\\n')) }")
    expect(result.code).toBe(0)
    expect(result.err).toContain('handled:')
  }, 30000)
})
