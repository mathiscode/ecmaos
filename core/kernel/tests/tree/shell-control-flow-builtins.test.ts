import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The four builtins that unwind the interpreter -- `break`, `continue`, `return`, `exit` -- plus the
 * three that rewrite the calling shell's own statement stream or arguments: `source`/`.`, `eval` and
 * `shift`. And `:`, which does nothing, on purpose.
 *
 * None of them can be an `execve`'d program. A child process cannot break its parent's loop, return
 * from its parent's function, or leave a variable behind in its parent, which is exactly why every
 * real shell keeps this set in-process. They are thrown as signals rather than reported as exit
 * codes because an exit code cannot distinguish "exited 1" from "stop the loop" -- see
 * `lib/shell-signals.ts`.
 *
 * `break`/`continue` existed before this, but only as a comparison of the statement's whole trimmed
 * text against `'break'` in `executeStatements`, so `break 2`, `break;` and `cond && break` all fell
 * through to a `$PATH` search for a `/bin/break` that does not exist. Those three cases are tested
 * here as regressions.
 */
describe('control-flow builtins: break/continue/return/exit/shift/source/eval/:', () => {
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

  const OUT = '/tmp/cf-builtins.out'

  // Scripts run in the kernel's own long-lived shell, so anything a test leaves behind is visible to
  // every test after it -- an `EXIT` trap in particular appends to `$OUT` on every later script.
  beforeEach(async () => {
    if (await kernel.filesystem.fs.exists(OUT)) await kernel.filesystem.fs.unlink(OUT)
    for (const [signal] of kernel.shell.listTraps()) kernel.shell.setTrap(undefined, signal)
    kernel.shell.clearPositionalParameters()
  })

  /** Runs `script` as a real script file through the kernel, returning its exit code and `$OUT`. */
  async function runScript(script: string): Promise<{ code: number, output: string }> {
    const path = '/tmp/cf-builtins.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    const code = await kernel.execute({ command: path, shell: kernel.shell })
    const output = await kernel.filesystem.fs.exists(OUT)
      ? await kernel.filesystem.fs.readFile(OUT, 'utf-8') as unknown as string
      : ''
    return { code, output }
  }

  const lines = (output: string): string[] => output.split('\n').filter(line => line !== '')

  describe('break', () => {
    it('leaves the innermost loop', async () => {
      const { output } = await runScript([
        'for i in 1 2 3; do',
        `  echo $i >> ${OUT}`,
        '  break',
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1'])
    })

    it('leaves N loops with `break 2`', async () => {
      // The whole reason the old exact-string check had to go: `break 2` was never recognized, so
      // the inner loop ran to completion three times over.
      const { output } = await runScript([
        'for i in 1 2; do',
        '  for j in a b; do',
        `    echo $i$j >> ${OUT}`,
        '    break 2',
        '  done',
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1a'])
    })

    it('breaks one level when only one is requested from a nested loop', async () => {
      const { output } = await runScript([
        'for i in 1 2; do',
        '  for j in a b; do',
        `    echo $i$j >> ${OUT}`,
        '    break',
        '  done',
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1a', '2a'])
    })

    it('fires from the right-hand side of `&&`', async () => {
      const { output } = await runScript([
        'for i in 1 2 3; do',
        `  echo $i >> ${OUT}`,
        '  test $i -eq 2 && break',
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1', '2'])
    })

    it('fires from inside an if branch', async () => {
      const { output } = await runScript([
        'for i in 1 2 3; do',
        '  if test $i -eq 2; then',
        '    break',
        '  fi',
        `  echo $i >> ${OUT}`,
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1'])
    })

    it('rejects a non-numeric level', async () => {
      const { code } = await runScript('for i in 1; do break two; done')
      expect(code).toBe(2)
    })

    it('treats `break 0` as `break 1`, as bash does', async () => {
      const { output } = await runScript([
        'for i in 1 2 3; do',
        `  echo $i >> ${OUT}`,
        '  break 0',
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1'])
    })

    it('does not escape a function to break the caller’s loop', async () => {
      // bash restricts a loop to being breakable only from within the same function, so a helper
      // that happens to contain a stray `break` must not stop the caller's loop.
      const { output } = await runScript([
        'helper() {',
        '  break',
        '}',
        'for i in 1 2 3; do',
        '  helper',
        `  echo $i >> ${OUT}`,
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1', '2', '3'])
    })
  })

  describe('continue', () => {
    it('skips the rest of the iteration', async () => {
      const { output } = await runScript([
        'for i in 1 2 3; do',
        '  test $i -eq 2 && continue',
        `  echo $i >> ${OUT}`,
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1', '3'])
    })

    it('restarts the Nth enclosing loop with `continue 2`', async () => {
      const { output } = await runScript([
        'for i in 1 2; do',
        '  for j in a b; do',
        `    echo $i$j >> ${OUT}`,
        '    continue 2',
        '  done',
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1a', '2a'])
    })

    it('works in a while loop without spinning', async () => {
      const { output } = await runScript([
        'n=0',
        'while test $n -lt 4; do',
        '  n=$((n + 1))',
        '  test $n -eq 2 && continue',
        `  echo $n >> ${OUT}`,
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1', '3', '4'])
    })
  })

  describe('exit', () => {
    it('ends the script with the given code', async () => {
      const { code, output } = await runScript([
        `echo before >> ${OUT}`,
        'exit 3',
        `echo after >> ${OUT}`
      ].join('\n'))
      expect(code).toBe(3)
      expect(lines(output)).toEqual(['before'])
    })

    it('ends the script from inside a loop', async () => {
      const { code, output } = await runScript([
        'for i in 1 2 3; do',
        `  echo $i >> ${OUT}`,
        '  exit 7',
        'done',
        `echo after >> ${OUT}`
      ].join('\n'))
      expect(code).toBe(7)
      expect(lines(output)).toEqual(['1'])
    })

    it('ends the script from inside a function', async () => {
      const { code, output } = await runScript([
        'bail() { exit 9; }',
        'bail',
        `echo after >> ${OUT}`
      ].join('\n'))
      expect(code).toBe(9)
      expect(output).toBe('')
    })

    it('reports $? when given no argument', async () => {
      const { code } = await runScript([
        'false',
        'exit'
      ].join('\n'))
      expect(code).toBe(1)
    })

    it('still runs the EXIT trap', async () => {
      const { code, output } = await runScript([
        `trap 'echo trapped >> ${OUT}' EXIT`,
        'exit 4'
      ].join('\n'))
      expect(code).toBe(4)
      expect(lines(output)).toEqual(['trapped'])
    })

    it('wraps a negative status into one byte, as a wait status does', async () => {
      const { code } = await runScript('exit -1')
      expect(code).toBe(255)
    })

    it('rejects a non-numeric status', async () => {
      const { code } = await runScript('exit later')
      expect(code).toBe(2)
    })
  })

  describe('return', () => {
    it('leaves a function with the given code', async () => {
      const { output } = await runScript([
        'f() {',
        `  echo in >> ${OUT}`,
        '  return 5',
        `  echo unreachable >> ${OUT}`,
        '}',
        'f',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['in', 'code=5'])
    })

    it('leaves a function from arbitrary depth', async () => {
      const { output } = await runScript([
        'f() {',
        '  for i in 1 2 3; do',
        '    if test $i -eq 2; then return 0; fi',
        `    echo $i >> ${OUT}`,
        '  done',
        `  echo tail >> ${OUT}`,
        '}',
        'f'
      ].join('\n'))
      expect(lines(output)).toEqual(['1'])
    })

    it('does not end the script', async () => {
      const { code, output } = await runScript([
        'f() { return 2; }',
        'f',
        `echo after >> ${OUT}`
      ].join('\n'))
      expect(code).toBe(0)
      expect(lines(output)).toEqual(['after'])
    })

    it('reports $? when given no argument', async () => {
      const { output } = await runScript([
        'f() { false; return; }',
        'f',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1'])
    })
  })

  describe('shift', () => {
    it('drops the first positional parameter', async () => {
      const { output } = await runScript([
        'f() {',
        '  shift',
        `  echo "$1 $2 count=$#" >> ${OUT}`,
        '}',
        'f a b c'
      ].join('\n'))
      expect(lines(output)).toEqual(['b c count=2'])
    })

    it('drops N with `shift N`, leaving $0 alone', async () => {
      const { output } = await runScript([
        'f() {',
        '  shift 2',
        `  echo "zero=$0 one=$1 count=$#" >> ${OUT}`,
        '}',
        'f a b c'
      ].join('\n'))
      expect(lines(output)).toEqual(['zero=f one=c count=1'])
    })

    it('fails without changing anything when N exceeds $#', async () => {
      // This is what terminates `while [ $# -gt 0 ]; do ...; shift; done` instead of spinning.
      const { output } = await runScript([
        'f() {',
        '  shift 5',
        `  echo "code=$? one=$1" >> ${OUT}`,
        '}',
        'f a b'
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1 one=a'])
    })

    it('drives an argument-consuming while loop to completion', async () => {
      const { output } = await runScript([
        'f() {',
        '  while test $# -gt 0; do',
        `    echo "$1" >> ${OUT}`,
        '    shift',
        '  done',
        '}',
        'f one two three'
      ].join('\n'))
      expect(lines(output)).toEqual(['one', 'two', 'three'])
    })
  })

  describe('source and .', () => {
    it('runs a file in the calling shell, so its variables persist', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/cf-sourced.sh', 'SOURCED_VALUE=fromfile\n')
      const { output } = await runScript([
        'source /tmp/cf-sourced.sh',
        `echo "$SOURCED_VALUE" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['fromfile'])
    })

    it('leaves a function behind, which is what an rc file needs', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/cf-sourced-fn.sh', ['greet() {', '  echo hello', '}'].join('\n') + '\n')
      const { output } = await runScript([
        '. /tmp/cf-sourced-fn.sh',
        `greet >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['hello'])
    })

    it('does not fire the EXIT trap of the shell that sourced it', async () => {
      // `source ~/.ecmashrc` must not run the shell's cleanup handler the moment the rc file ends,
      // which is why `source` uses `executeSourced` rather than `executeScriptText`.
      await kernel.filesystem.fs.writeFile('/tmp/cf-sourced-trap.sh', 'X=1\n')
      const { output } = await runScript([
        `trap 'echo trapped >> ${OUT}' EXIT`,
        'source /tmp/cf-sourced-trap.sh',
        `echo after >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['after', 'trapped'])
    })

    it('passes and restores positional parameters', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/cf-sourced-args.sh', `echo "inner=$1,$2" >> ${OUT}\n`)
      const { output } = await runScript([
        'f() {',
        '  source /tmp/cf-sourced-args.sh x y',
        `  echo "outer=$1,$2" >> ${OUT}`,
        '}',
        'f a b'
      ].join('\n'))
      expect(lines(output)).toEqual(['inner=x,y', 'outer=a,b'])
    })

    it('honors `return` from the sourced file without ending the caller', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/cf-sourced-return.sh', [
        `echo one >> ${OUT}`,
        'return 3',
        `echo two >> ${OUT}`
      ].join('\n') + '\n')
      const { code, output } = await runScript([
        'source /tmp/cf-sourced-return.sh',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(code).toBe(0)
      expect(lines(output)).toEqual(['one', 'code=3'])
    })

    it('lets `exit` in the sourced file end the caller', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/cf-sourced-exit.sh', 'exit 6\n')
      const { code, output } = await runScript([
        'source /tmp/cf-sourced-exit.sh',
        `echo after >> ${OUT}`
      ].join('\n'))
      expect(code).toBe(6)
      expect(output).toBe('')
    })

    it('finds a file in the working directory without a leading ./', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/cf-sourced-cwd.sh', 'CWD_SOURCED=yes\n')
      const { output } = await runScript([
        'cd /tmp',
        'source cf-sourced-cwd.sh',
        `echo "$CWD_SOURCED" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['yes'])
    })

    it('reports a missing file and exits non-zero', async () => {
      const { code } = await runScript('source /tmp/definitely-not-here.sh')
      expect(code).toBe(1)
    })

    it('needs a filename', async () => {
      const { code } = await runScript('source')
      expect(code).toBe(2)
    })
  })

  describe('eval', () => {
    it('runs its joined arguments in the calling shell', async () => {
      const { output } = await runScript([
        'eval "EVALED=yes"',
        `echo "$EVALED" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['yes'])
    })

    it('joins multiple arguments with a space', async () => {
      const { output } = await runScript([
        `eval echo joined >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['joined'])
    })

    it('runs a double round of expansion, which is the point of eval', async () => {
      const { output } = await runScript([
        'name=VALUE',
        'VALUE=indirect',
        `eval "echo \\$$name" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['indirect'])
    })

    it('reports its own exit code', async () => {
      const { output } = await runScript([
        'eval false',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1'])
    })

    it('succeeds silently with no arguments', async () => {
      const { code } = await runScript('eval')
      expect(code).toBe(0)
    })
  })

  describe(':', () => {
    it('succeeds and does nothing', async () => {
      const { code, output } = await runScript([
        ':',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(code).toBe(0)
      expect(lines(output)).toEqual(['code=0'])
    })

    it('serves as an always-true loop condition with a working break', async () => {
      const { output } = await runScript([
        'n=0',
        'while :; do',
        '  n=$((n + 1))',
        `  echo $n >> ${OUT}`,
        '  test $n -eq 3 && break',
        'done'
      ].join('\n'))
      expect(lines(output)).toEqual(['1', '2', '3'])
    })
  })

  describe('one-line function definitions', () => {
    it('defines and calls a function written entirely on one line', async () => {
      // The form every rc file uses. It matched no parser rule before, fell through as a plain
      // command line, and the shell reported `greet()` as a command not found.
      const { output } = await runScript([
        'greet() { echo hello; }',
        `greet >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['hello'])
    })

    it('runs every command in a `;`-joined one-line body', async () => {
      const { output } = await runScript([
        `both() { echo one >> ${OUT}; echo two >> ${OUT}; }`,
        'both'
      ].join('\n'))
      expect(lines(output)).toEqual(['one', 'two'])
    })

    it('honors control flow inside a one-line body', async () => {
      const { output } = await runScript([
        `check() { if test -d /tmp; then echo yes >> ${OUT}; fi; }`,
        'check'
      ].join('\n'))
      expect(lines(output)).toEqual(['yes'])
    })

    it('takes positional parameters like any other function', async () => {
      const { output } = await runScript([
        `pair() { echo "$1-$2" >> ${OUT}; }`,
        'pair a b'
      ].join('\n'))
      expect(lines(output)).toEqual(['a-b'])
    })

    it('accepts the function-keyword spelling too', async () => {
      const { output } = await runScript([
        `function greet2 { echo hi >> ${OUT}; }`,
        'greet2'
      ].join('\n'))
      expect(lines(output)).toEqual(['hi'])
    })
  })

  describe('at the top level, with nothing to unwind', () => {
    it('reports a stray break rather than throwing an internal error', async () => {
      // Before these were builtins, an unmatched `break` escaped as a raw `BreakSignal` all the way
      // to `Terminal`'s catch-all and printed an internal error in red.
      const code = await kernel.shell.execute('break')
      expect(code).toBe(0)
    })

    it('reports a stray return', async () => {
      const code = await kernel.shell.execute('return')
      expect(code).toBe(1)
    })

    it('turns an interactive exit into an exit code', async () => {
      const code = await kernel.shell.execute('exit 8')
      expect(code).toBe(8)
    })
  })
})
