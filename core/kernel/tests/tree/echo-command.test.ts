import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `echo` option parsing (`core/utils/src/commands-execve/echo.mjs`): an argument is an option only if it is `-`
 * followed by characters that are all `n`, `e` or `E`; everything else prints literally (`echo '---'`).
 */
describe('echo option parsing', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  const run = async (line: string, outPath: string) => {
    const code = await kernel.shell.execute(`${line} > ${outPath}`)
    const out = await kernel.filesystem.fs.readFile(outPath, 'utf-8')
    return { code, out }
  }

  it("prints a dash-leading operand literally instead of erroring", async () => {
    const { code, out } = await run("echo '---'", '/tmp/echo-dashes.txt')
    expect(code).toBe(0)
    expect(out).toBe('---\n')
  })

  it('prints an argument whose unknown flag letters are wrapped in dashes', async () => {
    const { code, out } = await run('echo "-n-"', '/tmp/echo-n-dash.txt')
    expect(code).toBe(0)
    expect(out).toBe('-n-\n')
  })

  it('prints an unrecognized single flag literally', async () => {
    const { code, out } = await run('echo -x', '/tmp/echo-x.txt')
    expect(code).toBe(0)
    expect(out).toBe('-x\n')
  })

  it('still honors -n', async () => {
    const { code, out } = await run('echo -n hello', '/tmp/echo-n.txt')
    expect(code).toBe(0)
    expect(out).toBe('hello')
  })

  it('still honors -e', async () => {
    const { code, out } = await run("echo -e 'a\\tb'", '/tmp/echo-e.txt')
    expect(code).toBe(0)
    expect(out).toBe('a\tb\n')
  })

  it('honors -E by leaving escapes uninterpreted', async () => {
    const { code, out } = await run("echo -E 'a\\tb'", '/tmp/echo-E.txt')
    expect(code).toBe(0)
    expect(out).toBe('a\\tb\n')
  })

  it('lets a later -E cancel an earlier -e', async () => {
    const { code, out } = await run("echo -e -E 'a\\tb'", '/tmp/echo-eE.txt')
    expect(code).toBe(0)
    expect(out).toBe('a\\tb\n')
  })

  it('accepts a combined -ne bundle', async () => {
    const { code, out } = await run("echo -ne 'a\\tb'", '/tmp/echo-ne.txt')
    expect(code).toBe(0)
    expect(out).toBe('a\tb')
  })

  it('stops parsing options at the first operand', async () => {
    const { code, out } = await run('echo hello -n', '/tmp/echo-trailing-n.txt')
    expect(code).toBe(0)
    expect(out).toBe('hello -n\n')
  })

  it('never writes a diagnostic into its own stdout', async () => {
    const { out } = await run("echo '--weird'", '/tmp/echo-weird.txt')
    expect(out).not.toContain('invalid option')
    expect(out).toBe('--weird\n')
  })
})
