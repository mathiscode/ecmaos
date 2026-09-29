import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Real `$IFS` and the `read` builtin, plus the command-prefix assignments that make them usable
 * together.
 *
 * Three things were missing and they only pay off as a set:
 *
 * - Word splitting was the hardcoded regex `/[ \t\n]+/` (`word-expansion.ts`), so `$IFS` was
 *   decorative. POSIX splits on two classes of character with different rules: a run of IFS
 *   whitespace delimits one field and is ignored at the edges, while *each* IFS non-whitespace
 *   character delimits a field, which is why `IFS=:` makes `a::b` three fields.
 * - There was no `read` at all, so no script could consume input line by line.
 * - `IFS= read -r line` did not even parse as a command. `tryExecuteAssignment` matched `IFS=` and,
 *   finding no `;`/`&&`/`|` after it, stored the literal text `read -r line` as IFS's value and ran
 *   nothing. Command-prefix assignments now belong to `runPipeline`, scoped to that pipeline.
 *
 * Together they make `while IFS= read -r line` work, which is the single most common loop in real
 * shell scripts and the reason this went first.
 */
describe('$IFS, read, and command-prefix assignments', () => {
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

  // Scripts run in the kernel's own long-lived shell, so an `IFS=` one test sets would otherwise
  // silently disable splitting for every test after it. Unset means the default, not empty.
  beforeEach(() => {
    kernel.shell.env.delete('IFS')
  })

  const OUT = '/tmp/ifs-read-test.out'

  async function runScript(script: string): Promise<{ code: number, output: string }> {
    const path = '/tmp/ifs-read-test.sh'
    if (await kernel.filesystem.fs.exists(OUT)) await kernel.filesystem.fs.unlink(OUT)
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    const code = await kernel.execute({ command: path, shell: kernel.shell })
    const output = await kernel.filesystem.fs.exists(OUT)
      ? await kernel.filesystem.fs.readFile(OUT, 'utf-8') as unknown as string
      : ''
    return { code, output }
  }

  /**
   * The exact fields `$x` splits into, via an array literal.
   *
   * `arr=($x)` is the one construct here that runs unquoted text through the real field expander and
   * then lets the count and each element be read back, so an empty field is observable rather than
   * being flattened into an output string. (`for f in $x` cannot be used: `executeFor` expands its
   * words with `expandWord`, which does no splitting at all -- a separate gap from `$IFS`.)
   */
  const showFields = (assign: string): string => [
    assign,
    'arr=($x)',
    `echo "count=\${#arr[@]}" >> ${OUT}`,
    `for i in 0 1 2 3; do echo "[\${arr[$i]}]" >> ${OUT}; done`
  ].join('\n')

  /** `{ count, fields }` from a `showFields` run, with the trailing unset slots dropped. */
  const parseFields = (output: string): { count: number, fields: string[] } => {
    const lines = output.split('\n').filter(line => line !== '')
    const count = Number((lines[0] as string).replace('count=', ''))
    return { count, fields: lines.slice(1, 1 + count) }
  }

  describe('word splitting honors $IFS', () => {
    it('splits on runs of whitespace by default, ignoring the edges', async () => {
      const { output } = await runScript(showFields("x='  a  b  '"))
      expect(parseFields(output)).toEqual({ count: 2, fields: ['[a]', '[b]'] })
    })

    it('treats each non-whitespace IFS character as its own delimiter', async () => {
      const { output } = await runScript(['IFS=:', showFields("x='a::b'")].join('\n'))
      // The middle field is empty and must survive: three fields, not two.
      expect(parseFields(output)).toEqual({ count: 3, fields: ['[a]', '[]', '[b]'] })
    })

    it('does not add a trailing empty field for a trailing delimiter', async () => {
      const { output } = await runScript(['IFS=:', showFields("x='a:'")].join('\n'))
      expect(parseFields(output)).toEqual({ count: 1, fields: ['[a]'] })
    })

    it('keeps a leading empty field for a leading delimiter', async () => {
      const { output } = await runScript(['IFS=:', showFields("x=':a'")].join('\n'))
      expect(parseFields(output)).toEqual({ count: 2, fields: ['[]', '[a]'] })
    })

    it('absorbs IFS whitespace around a non-whitespace delimiter', async () => {
      const { output } = await runScript(["IFS=' :'", showFields("x='a : : b'")].join('\n'))
      expect(parseFields(output)).toEqual({ count: 3, fields: ['[a]', '[]', '[b]'] })
    })

    it('stops splitting entirely when IFS is set but empty', async () => {
      const { output } = await runScript(['IFS=', showFields("x='a b  c'")].join('\n'))
      expect(parseFields(output)).toEqual({ count: 1, fields: ['[a b  c]'] })
    })

    it('splits on a custom single character', async () => {
      const { output } = await runScript(['IFS=,', showFields("x='x,y,,z'")].join('\n'))
      expect(parseFields(output)).toEqual({ count: 4, fields: ['[x]', '[y]', '[]', '[z]'] })
    })
  })

  describe('read', () => {
    it('assigns the line to REPLY with no names', async () => {
      const { output } = await runScript([
        `read <<< 'hello world'`,
        `echo "[$REPLY]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[hello world]')
    })

    it('splits into several names on $IFS', async () => {
      const { output } = await runScript([
        `read a b <<< '1 2'`,
        `echo "[$a][$b]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[1][2]')
    })

    it('gives the last name the rest of the line, delimiters intact', async () => {
      const { output } = await runScript([
        `read a b <<< '1 2 3 4'`,
        `echo "[$a][$b]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[1][2 3 4]')
    })

    it('leaves extra names empty', async () => {
      const { output } = await runScript([
        `read a b c <<< 'only'`,
        `echo "[$a][$b][$c]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[only][][]')
    })

    it('splits on a custom IFS', async () => {
      const { output } = await runScript([
        `IFS=: read a b <<< 'root:x'`,
        `echo "[$a][$b]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[root][x]')
    })

    it('strips backslashes without -r, keeps them with -r', async () => {
      const cooked = await runScript([`read a <<< 'a\\tb'`, `echo "[$a]" >> ${OUT}`].join('\n'))
      expect(cooked.output.trim()).toBe('[atb]')

      const rawRead = await runScript([`read -r a <<< 'a\\tb'`, `echo "[$a]" >> ${OUT}`].join('\n'))
      expect(rawRead.output.trim()).toBe('[a\\tb]')
    })

    it('exits non-zero at end of file', async () => {
      // An empty regular file, not `/dev/null`: reading that device hangs, because its driver op
      // reports a full buffer instead of 0 (see `createFileReadStream`). Tracked for Phase 4.
      const empty = '/tmp/ifs-read-empty.txt'
      await kernel.filesystem.fs.writeFile(empty, '')

      const { output } = await runScript([
        `read a < ${empty}`,
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('code=1')
    })

    it('rejects an invalid identifier', async () => {
      const { output } = await runScript([
        `read 1bad <<< 'x' 2>/dev/null`,
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('code=1')
    })

    it('rejects the options it does not implement rather than misreading them', async () => {
      const { output } = await runScript([
        `read -n 3 a <<< 'abcdef' 2>/dev/null`,
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('code=2')
    })
  })

  describe('while IFS= read -r line', () => {
    it('reads a file line by line, preserving each line\'s own whitespace', async () => {
      const input = '/tmp/ifs-read-input.txt'
      await kernel.filesystem.fs.writeFile(input, 'one\n  indented  \nthree\n')

      const { output } = await runScript([
        `while IFS= read -r line; do`,
        `  echo "[$line]" >> ${OUT}`,
        `done < ${input}`
      ].join('\n'))

      expect(output.trim().split('\n')).toEqual(['[one]', '[  indented  ]', '[three]'])
    })

    it('without IFS= the same loop loses leading and trailing whitespace', async () => {
      const input = '/tmp/ifs-read-input2.txt'
      await kernel.filesystem.fs.writeFile(input, '  padded  \n')

      const { output } = await runScript([
        `while read -r line; do`,
        `  echo "[$line]" >> ${OUT}`,
        `done < ${input}`
      ].join('\n'))

      expect(output.trim()).toBe('[padded]')
    })
  })

  describe('command-prefix assignments', () => {
    it('applies only for the duration of the command', async () => {
      const { output } = await runScript([
        'IFS=original',
        `IFS=: read a b <<< 'p:q'`,
        `echo "[$a][$b][$IFS]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[p][q][original]')
    })

    it('leaves a variable unset afterwards when it was unset before', async () => {
      const { output } = await runScript([
        `PREFIX_ONLY=x echo skip > /dev/null`,
        `echo "[${'$'}{PREFIX_ONLY-unset}]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[unset]')
    })

    it('runs the command rather than assigning the rest of the line', async () => {
      const { output } = await runScript([
        `FOO=bar echo ran >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('ran')
    })

    it('still treats a bare assignment as an assignment', async () => {
      const { output } = await runScript([
        'PLAIN=kept',
        `echo "[$PLAIN]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[kept]')
    })

    it('still treats a quoted assignment value with spaces as one value', async () => {
      const { output } = await runScript([
        'SPACED="a b"',
        `echo "[$SPACED]" >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('[a b]')
    })

    it('expands the value left to right', async () => {
      const { output } = await runScript([
        `A=1 B=$A echo skip > /dev/null`,
        `A=1 B=2 sh_unused=x echo done >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('done')
    })

    it('respects quoting in the assigned value', async () => {
      const { output } = await runScript([
        'HOMEVAR=/somewhere',
        `LITERAL='$HOMEVAR' env > /tmp/ifs-prefix-env.out`,
        `grep -c 'LITERAL=\\$HOMEVAR' /tmp/ifs-prefix-env.out >> ${OUT}`
      ].join('\n'))
      expect(output.trim()).toBe('1')
    })
  })
})
