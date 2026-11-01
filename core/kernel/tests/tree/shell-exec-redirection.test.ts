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

  it('opens a file for reading and writing with exec 3<>, and reads it back with <&3', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/exec-rw.txt', 'first\n')
    await runScript([
      'exec 3<> /tmp/exec-rw.txt',
      'read -r line <&3',
      'echo "second" >&3',
      'exec 3>&-',
      `echo "$line" > ${LOG}`
    ].join('\n'))
    expect(await read(LOG)).toBe('first\n')
    expect(await read('/tmp/exec-rw.txt')).toBe('first\nsecond\n')
  })

  it('makes the file with <> when it is not there', async () => {
    try { await kernel.filesystem.fs.unlink('/tmp/exec-new.txt') } catch { /* already absent */ }
    await runScript('exec 3<> /tmp/exec-new.txt\nexec 3>&-')
    expect(await read('/tmp/exec-new.txt')).toBe('')
  })

  it('hands what is left of an open descriptor to a command with <&3, and lets go with <&-', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/exec-lines.txt', 'l1\nl2\nl3\n')
    await runScript([
      'exec 3< /tmp/exec-lines.txt',
      'read -r a <&3',
      'read -r b <&3',
      `{ cat <&3; echo "$a $b"; } > ${LOG}`,
      'exec 3<&-'
    ].join('\n'))
    expect(await read(LOG)).toBe('l3\nl1 l2\n')
    await runScript(`cat <&- > ${LOG}; echo "closed=$?" >> ${LOG}`)
    expect(await read(LOG)).toBe('closed=0\n')
  })

  it('duplicates descriptors with exec 4>&3 and 4<&3, and keeps earlier exec outputs when another is installed', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/exec-dup.txt', 'one\ntwo\n')
    await runScript([
      'exec 3>/tmp/exec-o3.txt',
      'exec 4>/tmp/exec-o4.txt',
      'exec 5>&3',
      'echo to3 >&3',
      'echo to4 >&4',
      'echo via5 >&5',
      'exec 3>&- 4>&- 5>&-',
      'exec 6< /tmp/exec-dup.txt',
      'exec 7<&6',
      'read -r x <&7',
      `echo "$x" > ${LOG}`
    ].join('\n'))
    expect(await read('/tmp/exec-o3.txt')).toBe('to3\nvia5\n')
    expect(await read('/tmp/exec-o4.txt')).toBe('to4\n')
    expect(await read(LOG)).toBe('one\n')
  })

  it('refuses a descriptor that is not open', async () => {
    expect(await runScript(`exec 8>&-\necho nowhere >&8 2> ${LOG}`)).not.toBe(0)
  })
})
