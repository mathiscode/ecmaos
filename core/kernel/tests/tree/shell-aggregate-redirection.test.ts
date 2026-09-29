import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Redirections on an *aggregate* command: a compound statement's closing keyword (`done > out`), a
 * function call (`greet > out`), and `eval`/`source`.
 *
 * None of the three is a command with a set of fds. Each runs a whole statement tree whose commands
 * build their own streams, so the redirection was parsed and then silently discarded -- `done > out`
 * left `out` untouched and printed to the screen, exactly the bug `done < f` had on the input side.
 * `Shell` now holds the redirection for the duration of the aggregate command and every command
 * inside it inherits it, with its own redirection still winning.
 *
 * The subtle half is truncation. `> out` must truncate once for the whole statement, not once per
 * command in the body, or `for f in a b; do echo $f; done > out` would leave only `b` behind.
 */
describe('redirections on aggregate commands', () => {
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

  const OUT = '/tmp/aggregate-redirect.out'
  const ERR = '/tmp/aggregate-redirect.err'

  beforeEach(async () => {
    for (const path of [OUT, ERR]) {
      try { await kernel.filesystem.fs.unlink(path) } catch { /* not there, which is the state we want */ }
    }
    for (const [signal] of kernel.shell.listTraps()) kernel.shell.setTrap(undefined, signal)
  })

  async function runScript(script: string): Promise<number> {
    const path = '/tmp/aggregate-redirect.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    return await kernel.execute({ command: path, shell: kernel.shell })
  }

  const read = async (path: string): Promise<string> => await kernel.filesystem.fs.exists(path)
    ? await kernel.filesystem.fs.readFile(path, 'utf-8') as unknown as string
    : '<missing>'

  describe('compound statements', () => {
    it('sends a whole for-loop body to one file', async () => {
      const code = await runScript(['for i in 1 2 3; do', '  echo $i', `done > ${OUT}`].join('\n'))
      expect(code).toBe(0)
      expect(await read(OUT)).toBe('1\n2\n3\n')
    })

    it('truncates once for the statement, not once per iteration', async () => {
      // The whole point of tracking which fds a statement has already truncated: without it every
      // `echo` reopens the file from the top and only the last iteration survives.
      await kernel.filesystem.fs.writeFile(OUT, 'stale\n')
      await runScript(['for i in a b; do', '  echo $i', `done > ${OUT}`].join('\n'))
      expect(await read(OUT)).toBe('a\nb\n')
    })

    it('appends across the statement with `done >>`', async () => {
      await kernel.filesystem.fs.writeFile(OUT, 'kept\n')
      await runScript(['for i in a b; do', '  echo $i', `done >> ${OUT}`].join('\n'))
      expect(await read(OUT)).toBe('kept\na\nb\n')
    })

    it('redirects a while loop', async () => {
      const code = await runScript([
        'n=0',
        'while test $n -lt 3; do',
        '  n=$((n + 1))',
        '  echo line$n',
        `done > ${OUT}`
      ].join('\n'))
      expect(code).toBe(0)
      expect(await read(OUT)).toBe('line1\nline2\nline3\n')
    })

    it('redirects an if statement', async () => {
      await runScript(['if true; then', '  echo taken', `fi > ${OUT}`].join('\n'))
      expect(await read(OUT)).toBe('taken\n')
    })

    it('lets an inner redirection win over the statement’s', async () => {
      await runScript([
        'for i in 1 2; do',
        `  echo inner$i > ${ERR}`,
        '  echo outer$i',
        `done > ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('outer1\nouter2\n')
      // Each `echo inner` opened the file itself, so only the last one's output remains -- a command's
      // own `>` is not covered by the statement's already-truncated bookkeeping, and should not be.
      expect(await read(ERR)).toBe('inner2\n')
    })

    it('carries an input and an output redirection on the same keyword', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/aggregate-input.txt', 'one\ntwo\n')
      const code = await runScript([
        'while read -r line; do',
        '  echo "got $line"',
        `done < /tmp/aggregate-input.txt > ${OUT}`
      ].join('\n'))
      expect(code).toBe(0)
      expect(await read(OUT)).toBe('got one\ngot two\n')
    })

    it('redirects only fd 2 with `done 2>`', async () => {
      await runScript([
        'for i in 1; do',
        '  echo out',
        '  ls /definitely-not-here',
        `done 2> ${ERR}`
      ].join('\n'))
      expect(await read(ERR)).not.toBe('')
      expect(await read(ERR)).not.toBe('<missing>')
    })
  })

  describe('function calls', () => {
    it('redirects a function’s whole body', async () => {
      const code = await runScript([
        'greet() {',
        '  echo hello',
        '  echo again',
        '}',
        `greet > ${OUT}`
      ].join('\n'))
      expect(code).toBe(0)
      expect(await read(OUT)).toBe('hello\nagain\n')
    })

    it('appends with `fn >>`', async () => {
      await kernel.filesystem.fs.writeFile(OUT, 'first\n')
      await runScript(['emit() {', '  echo second', '}', `emit >> ${OUT}`].join('\n'))
      expect(await read(OUT)).toBe('first\nsecond\n')
    })

    it('reaches a loop nested inside the function', async () => {
      await runScript([
        'listem() {',
        '  for i in x y; do',
        '    echo $i',
        '  done',
        '}',
        `listem > ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('x\ny\n')
    })

    it('does not leak past the call', async () => {
      await runScript([
        'quiet() {',
        '  echo hidden',
        '}',
        `quiet > ${OUT}`,
        `echo visible > ${ERR}`
      ].join('\n'))
      expect(await read(OUT)).toBe('hidden\n')
      expect(await read(ERR)).toBe('visible\n')
    })

    it('feeds a function’s body from `fn < file`', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/aggregate-fn-input.txt', 'alpha\nbeta\n')
      await runScript([
        'consume() {',
        '  read -r first',
        '  read -r second',
        '  echo "$first|$second"',
        '}',
        `consume < /tmp/aggregate-fn-input.txt > ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('alpha|beta\n')
    })
  })

  describe('eval and source', () => {
    it('redirects what eval runs, not just eval', async () => {
      const code = await runScript(`eval echo evaled > ${OUT}`)
      expect(code).toBe(0)
      expect(await read(OUT)).toBe('evaled\n')
    })

    it('redirects every command in a sourced file', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/aggregate-sourced.sh', 'echo from-file\necho second-line\n')
      await runScript(`source /tmp/aggregate-sourced.sh > ${OUT}`)
      expect(await read(OUT)).toBe('from-file\nsecond-line\n')
    })
  })
})
