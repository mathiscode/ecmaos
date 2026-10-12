import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Brace expansion reaches every path that turns a word into fields: command arguments, a `for` list and an array
 * literal. It does not consult the filesystem (`mkdir -p src/{lib,bin}` makes two directories).
 */
describe('brace expansion in the shell', () => {
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

  const OUT = '/tmp/brace.out'

  beforeEach(async () => {
    try { await kernel.filesystem.fs.unlink(OUT) } catch { /* already absent */ }
  })

  async function runScript(script: string): Promise<string> {
    const path = '/tmp/brace.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    await kernel.execute({ command: path, shell: kernel.shell })
    return await kernel.filesystem.fs.exists(OUT)
      ? await kernel.filesystem.fs.readFile(OUT, 'utf-8') as unknown as string
      : ''
  }

  const lines = (output: string): string[] => output.split('\n').filter(line => line !== '')

  it('expands a comma list into separate arguments', async () => {
    expect(await runScript(`echo {a,b,c} >> ${OUT}`)).toBe('a b c\n')
  })

  it('expands a sequence', async () => {
    expect(await runScript(`echo {1..5} >> ${OUT}`)).toBe('1 2 3 4 5\n')
  })

  it('creates directories that do not exist yet', async () => {
    // The case that separates brace expansion from globbing: nothing here can be matched, it has to
    // be generated. This used to make one directory named `src/{lib,bin}`.
    await runScript([
      'rm -rf /tmp/brace-root',
      'mkdir -p /tmp/brace-root/{lib,bin}',
      `ls /tmp/brace-root >> ${OUT}`
    ].join('\n'))
    const output = await runScript(`ls /tmp/brace-root >> ${OUT}`)
    expect(output).toContain('lib')
    expect(output).toContain('bin')
  })

  it('reaches a for list', async () => {
    const output = await runScript([
      'for i in {1..3}; do',
      `  echo line$i >> ${OUT}`,
      'done'
    ].join('\n'))
    expect(lines(output)).toEqual(['line1', 'line2', 'line3'])
  })

  it('reaches an array literal', async () => {
    const output = await runScript([
      'arr=({a,b,c})',
      `echo "count=\${#arr[@]} second=\${arr[1]}" >> ${OUT}`
    ].join('\n'))
    expect(lines(output)).toEqual(['count=3 second=b'])
  })

  it('combines with a variable in the same word', async () => {
    const output = await runScript([
      'base=/tmp',
      `echo $base/{x,y} >> ${OUT}`
    ].join('\n'))
    expect(output).toBe('/tmp/x /tmp/y\n')
  })

  it('expands before parameter expansion, not after', async () => {
    // `{1,2}` is textual: it cannot see that `a1` and `a2` are variables until afterwards.
    const output = await runScript([
      'a1=first',
      'a2=second',
      `echo $\{a1} $\{a2} >> ${OUT}`
    ].join('\n'))
    expect(output).toBe('first second\n')
  })

  it('does not expand a quoted brace', async () => {
    expect(await runScript(`echo "{a,b}" >> ${OUT}`)).toBe('{a,b}\n')
  })

  it('leaves a parameter expansion containing a comma alone', async () => {
    const output = await runScript([
      'unset maybe',
      `echo \${maybe:-a,b} >> ${OUT}`
    ].join('\n'))
    expect(output).toBe('a,b\n')
  })

  it('leaves a braceless word and a no-comma brace alone', async () => {
    expect(await runScript(`echo plain {foo} >> ${OUT}`)).toBe('plain {foo}\n')
  })

  it('multiplies nested and adjacent braces', async () => {
    expect(await runScript(`echo {a,b}{1,2} >> ${OUT}`)).toBe('a1 a2 b1 b2\n')
  })
})
