import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Real, booted-kernel proof of control flow, functions, `local`, `set -e/-u/-o pipefail`, variable
 * expansion, and arithmetic -- none of which existed before this branch (`Kernel.executeScript`
 * used to be a flat `line.split('\n')` with no way for `then`/`do`/`fi` to span lines at all).
 */
describe('Shell control flow, functions, and variable/arithmetic expansion', () => {
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

  async function runScript(script: string, path = '/tmp/control-flow-test.sh'): Promise<{ code: number, output: string }> {
    const outPath = '/tmp/control-flow-test.out'
    if (await kernel.filesystem.fs.exists(outPath)) await kernel.filesystem.fs.unlink(outPath)
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    const code = await kernel.execute({ command: path, shell: kernel.shell })
    const output = await kernel.filesystem.fs.exists(outPath)
      ? await kernel.filesystem.fs.readFile(outPath, 'utf-8')
      : ''
    return { code, output }
  }

  describe('variable and arithmetic expansion', () => {
    it('expands a plain $VAR in a command word', async () => {
      const { output } = await runScript('X=hello\necho $X >> /tmp/control-flow-test.out')
      expect(output.trim()).toBe('hello')
    })

    it('expands ${VAR:-default} for an unset variable', async () => {
      const { output } = await runScript('echo ${UNSET_VAR:-fallback} >> /tmp/control-flow-test.out')
      expect(output.trim()).toBe('fallback')
    })

    it('evaluates $((...)) arithmetic and stores it via assignment', async () => {
      const { output } = await runScript('X=2\nY=$((X + 3))\necho $Y >> /tmp/control-flow-test.out')
      expect(output.trim()).toBe('5')
    })
  })

  describe('if/elif/else/fi', () => {
    it('runs the then-branch when the condition succeeds', async () => {
      const { code, output } = await runScript([
        'if true; then',
        '  echo yes >> /tmp/control-flow-test.out',
        'fi'
      ].join('\n'))
      expect(code).toBe(0)
      expect(output.trim()).toBe('yes')
    })

    it('runs the else-branch when the condition fails', async () => {
      const { output } = await runScript([
        'if false; then',
        '  echo yes >> /tmp/control-flow-test.out',
        'else',
        '  echo no >> /tmp/control-flow-test.out',
        'fi'
      ].join('\n'))
      expect(output.trim()).toBe('no')
    })

    it('falls through elif branches in order', async () => {
      const { output } = await runScript([
        'X=2',
        'if test $X -eq 1; then',
        '  echo one >> /tmp/control-flow-test.out',
        'elif test $X -eq 2; then',
        '  echo two >> /tmp/control-flow-test.out',
        'else',
        '  echo other >> /tmp/control-flow-test.out',
        'fi'
      ].join('\n'))
      expect(output.trim()).toBe('two')
    })
  })

  describe('while/do/done', () => {
    it('loops until the condition fails, honoring assignment and arithmetic each iteration', async () => {
      const { output } = await runScript([
        'I=0',
        'while test $I -lt 3; do',
        '  echo $I >> /tmp/control-flow-test.out',
        '  I=$((I + 1))',
        'done'
      ].join('\n'))
      expect(output.trim().split('\n')).toEqual(['0', '1', '2'])
    })

    it('honors break and continue', async () => {
      const { output } = await runScript([
        'I=0',
        'while test $I -lt 5; do',
        '  I=$((I + 1))',
        '  if test $I -eq 2; then',
        '    continue',
        '  fi',
        '  if test $I -eq 4; then',
        '    break',
        '  fi',
        '  echo $I >> /tmp/control-flow-test.out',
        'done'
      ].join('\n'))
      expect(output.trim().split('\n')).toEqual(['1', '3'])
    })
  })

  describe('for/in/do/done', () => {
    it('iterates over a literal word list', async () => {
      const { output } = await runScript('for x in a b c; do\n  echo $x >> /tmp/control-flow-test.out\ndone')
      expect(output.trim().split('\n')).toEqual(['a', 'b', 'c'])
    })
  })

  describe('case/esac', () => {
    it('matches the first patterns clause and skips the rest', async () => {
      const script = [
        'X=b',
        'case $X in',
        '  a)',
        '    echo matched-a >> /tmp/control-flow-test.out',
        '    ;;',
        '  b|c)',
        '    echo matched-bc >> /tmp/control-flow-test.out',
        '    ;;',
        '  *)',
        '    echo matched-default >> /tmp/control-flow-test.out',
        '    ;;',
        'esac'
      ].join('\n')
      const { output } = await runScript(script)
      expect(output.trim()).toBe('matched-bc')
    })

    it('falls back to the * clause when nothing else matches', async () => {
      const script = ['X=z', 'case $X in', '  a) echo a >> /tmp/control-flow-test.out ;;', '  *) echo default >> /tmp/control-flow-test.out ;;', 'esac'].join('\n')
      const { output } = await runScript(script)
      expect(output.trim()).toBe('default')
    })
  })

  describe('functions and local', () => {
    it('defines and calls a function, with positional parameters set to its arguments', async () => {
      const script = [
        'greet() {',
        '  echo hello $1 >> /tmp/control-flow-test.out',
        '}',
        'greet world'
      ].join('\n')
      const { output } = await runScript(script)
      expect(output.trim()).toBe('hello world')
    })

    it('scopes local variables to the function call without leaking to the caller', async () => {
      const script = [
        'X=outer',
        'set_local() {',
        '  local X=inner',
        '  echo in-fn:$X >> /tmp/control-flow-test.out',
        '}',
        'set_local',
        'echo after-fn:$X >> /tmp/control-flow-test.out'
      ].join('\n')
      const { output } = await runScript(script)
      expect(output.trim().split('\n')).toEqual(['in-fn:inner', 'after-fn:outer'])
    })
  })

  describe('set -e / -u / -o pipefail', () => {
    it('set -e stops the script at the first failing command', async () => {
      const { code, output } = await runScript([
        'set -e',
        'true',
        'echo before >> /tmp/control-flow-test.out',
        'false',
        'echo after >> /tmp/control-flow-test.out'
      ].join('\n'))
      expect(code).not.toBe(0)
      expect(output.trim()).toBe('before')
    })

    it('set -u fails a command referencing an unset variable', async () => {
      const { code } = await runScript(['set -u', 'echo $TOTALLY_UNSET_VAR >> /tmp/control-flow-test.out'].join('\n'))
      expect(code).not.toBe(0)
    })

    it('set -o pipefail reports the last non-zero stage as the pipeline exit code', async () => {
      const code = await kernel.shell.execute('set -o pipefail')
      expect(code).toBe(0)
      const pipelineCode = await kernel.shell.execute('false | true')
      expect(pipelineCode).not.toBe(0)
      // Restore default state for any subsequent test relying on the pre-existing behavior.
      await kernel.shell.execute('set +o pipefail')
    })
  })
})




