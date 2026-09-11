import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('Shell.execute — real execution over the new parser', () => {
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

  async function run(line: string): Promise<number> {
    return kernel.shell.execute(line)
  }

  async function runCapturing(line: string, path = '/tmp/shell-execute-test.out'): Promise<{ code: number, output: string }> {
    if (await kernel.filesystem.fs.exists(path)) await kernel.filesystem.fs.unlink(path)
    const code = await kernel.shell.execute(`${line} > ${path}`)
    const output = await kernel.filesystem.fs.exists(path)
      ? await kernel.filesystem.fs.readFile(path, 'utf-8')
      : ''
    return { code, output }
  }

  it('runs a single command', async () => {
    const { code, output } = await runCapturing('echo hello')
    expect(code).toBe(0)
    expect(output.trim()).toBe('hello')
  })

  it('does not split a quoted pipe character into a pipeline', async () => {
    const { output } = await runCapturing('echo "a | b"')
    expect(output.trim()).toBe('a | b')
  })

  it('does not split a quoted semicolon into two commands', async () => {
    const { output } = await runCapturing('echo "a ; b"')
    expect(output.trim()).toBe('a ; b')
  })

  it('runs a real pipeline through two commands', async () => {
    const { output } = await runCapturing('echo hello | rev')
    expect(output.trim()).toBe('olleh')
  })

  it('runs a three-stage pipeline', async () => {
    const { output } = await runCapturing('echo abc | tr a-z A-Z | rev')
    expect(output.trim()).toBe('CBA')
  })

  it('supports || — the defect the old split-chain could not express at all', async () => {
    const code = await run('false || true')
    expect(code).toBe(0)
  })

  it('does not run the right-hand side of && after a failure', async () => {
    if (await kernel.filesystem.fs.exists('/tmp/shell-and-test.out')) {
      await kernel.filesystem.fs.unlink('/tmp/shell-and-test.out')
    }
    await run('false && echo unreachable > /tmp/shell-and-test.out')
    expect(await kernel.filesystem.fs.exists('/tmp/shell-and-test.out')).toBe(false)
  })

  it('does run the right-hand side of && after success', async () => {
    const { output } = await runCapturing('true && echo reached')
    expect(output.trim()).toBe('reached')
  })

  it('does not run the right-hand side of || after success', async () => {
    if (await kernel.filesystem.fs.exists('/tmp/shell-or-test.out')) {
      await kernel.filesystem.fs.unlink('/tmp/shell-or-test.out')
    }
    await run('true || echo unreachable > /tmp/shell-or-test.out')
    expect(await kernel.filesystem.fs.exists('/tmp/shell-or-test.out')).toBe(false)
  })

  it('runs c in "a && b || c" when a fails, per left-associative shell semantics', async () => {
    const { output } = await runCapturing('false && echo b || echo c')
    expect(output.trim()).toBe('c')
  })

  it('always runs the next command after ;, regardless of exit code', async () => {
    const { output } = await runCapturing('false ; echo still-here')
    expect(output.trim()).toBe('still-here')
  })

  it('sets $? to the exit code of the last command run', async () => {
    await run('false')
    expect(kernel.shell.env.get('?')).toBe('1')
    await run('true')
    expect(kernel.shell.env.get('?')).toBe('0')
  })

  it('sets PIPESTATUS to every stage\'s exit code, not just the last', async () => {
    await run('false | true')
    expect(kernel.shell.env.get('PIPESTATUS')).toBe('1 0')
  })

  it('redirects stdout to a file with >, truncating', async () => {
    const path = '/tmp/shell-redirect-test.txt'
    await kernel.filesystem.fs.writeFile(path, 'stale content')
    await run(`echo fresh > ${path}`)
    expect((await kernel.filesystem.fs.readFile(path, 'utf-8')).trim()).toBe('fresh')
  })

  it('appends stdout to a file with >>', async () => {
    const path = '/tmp/shell-append-test.txt'
    if (await kernel.filesystem.fs.exists(path)) await kernel.filesystem.fs.unlink(path)
    await run(`echo one > ${path}`)
    await run(`echo two >> ${path}`)
    const content = await kernel.filesystem.fs.readFile(path, 'utf-8')
    expect(content).toBe('one\ntwo\n')
  })

  it('reads stdin from a file with <', async () => {
    const inPath = '/tmp/shell-input-test.txt'
    await kernel.filesystem.fs.writeFile(inPath, 'from-file')
    const { output } = await runCapturing(`rev < ${inPath}`)
    expect(output.trim()).toBe('elif-morf')
  })
})
