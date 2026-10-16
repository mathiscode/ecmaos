import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `exec` with redirections and no command (`exec > run.log 2>&1`). The command form (`exec prog args`) is reported as
 * unsupported, since the shell is not a worker program.
 */
describe('exec redirections', () => {
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

  const LOG = '/tmp/exec-log.txt'

  beforeEach(async () => {
    try { await kernel.filesystem.fs.unlink(LOG) } catch { /* already absent */ }
  })

  async function runScript(script: string): Promise<number> {
    const path = '/tmp/exec-redirect.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    return await kernel.execute({ command: path, shell: kernel.shell })
  }

  const read = async (path: string): Promise<string> => await kernel.filesystem.fs.exists(path)
    ? await kernel.filesystem.fs.readFile(path, 'utf-8') as unknown as string
    : '<missing>'

  it('sends everything after it to a file', async () => {
    await runScript([
      `exec > ${LOG}`,
      'echo first',
      'echo second',
      'exec > /dev/null'
    ].join('\n'))
    expect(await read(LOG)).toBe('first\nsecond\n')
  })

  it('truncates once, not once per command', async () => {
    await kernel.filesystem.fs.writeFile(LOG, 'stale\n')
    await runScript([
      `exec > ${LOG}`,
      'echo a',
      'echo b',
      'exec > /dev/null'
    ].join('\n'))
    expect(await read(LOG)).toBe('a\nb\n')
  })

  it('reaches inside a loop', async () => {
    await runScript([
      `exec > ${LOG}`,
      'for i in 1 2 3; do echo line$i; done',
      'exec > /dev/null'
    ].join('\n'))
    expect(await read(LOG)).toBe('line1\nline2\nline3\n')
  })

  it('reaches a builtin, which would otherwise write straight to the terminal', async () => {
    await runScript([
      `exec > ${LOG}`,
      'export EXEC_MARKER=seen',
      'export -p',
      'exec > /dev/null'
    ].join('\n'))
    expect(await read(LOG)).toContain('EXEC_MARKER=seen')
  })

  it('appends with exec >>', async () => {
    await kernel.filesystem.fs.writeFile(LOG, 'kept\n')
    await runScript([
      `exec >> ${LOG}`,
      'echo added',
      'exec > /dev/null'
    ].join('\n'))
    expect(await read(LOG)).toBe('kept\nadded\n')
  })

  it('lets a command’s own redirection still win', async () => {
    await runScript([
      `exec > ${LOG}`,
      'echo elsewhere > /tmp/exec-other.txt',
      'echo logged',
      'exec > /dev/null'
    ].join('\n'))
    expect(await read(LOG)).toBe('logged\n')
    expect(await read('/tmp/exec-other.txt')).toBe('elsewhere\n')
  })

  it('redirects fd 2 on its own', async () => {
    await runScript([
      `exec 2> ${LOG}`,
      'ls /definitely-not-here',
      'exec 2> /dev/null'
    ].join('\n'))
    expect(await read(LOG)).toContain('/definitely-not-here')
  })

  it('feeds the shell from a file with exec <', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/exec-input.txt', 'alpha\nbeta\n')
    await runScript([
      'exec < /tmp/exec-input.txt',
      'read -r one',
      'read -r two',
      `echo "$one|$two" > ${LOG}`
    ].join('\n'))
    expect(await read(LOG)).toBe('alpha|beta\n')
  })

  it('runs the command form and leaves with its status', async () => {
    expect(await runScript('exec sh -c "exit 4"')).toBe(4)
  })
})
