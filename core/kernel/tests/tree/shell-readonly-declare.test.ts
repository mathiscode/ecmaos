import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `readonly` and `declare`/`typeset`.
 *
 * The readonly attribute is shell-wide rather than per-scope, matching bash: it lives on the
 * variable, so a later assignment fails wherever it happens, and there is no way to take it back --
 * which is the entire point, since a script marks a name readonly precisely to rely on it.
 */
describe('readonly and declare', () => {
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

  const OUT = '/tmp/readonly.out'

  beforeEach(async () => {
    try { await kernel.filesystem.fs.unlink(OUT) } catch { /* already absent */ }
    kernel.shell.functions.clear()
  })

  async function runScript(script: string): Promise<string> {
    const path = '/tmp/readonly.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    await kernel.execute({ command: path, shell: kernel.shell })
    return await kernel.filesystem.fs.exists(OUT)
      ? await kernel.filesystem.fs.readFile(OUT, 'utf-8') as unknown as string
      : ''
  }

  const lines = (output: string): string[] => output.split('\n').filter(line => line !== '')

  describe('readonly', () => {
    it('refuses a later assignment and keeps the original value', async () => {
      const output = await runScript([
        'readonly RO_KEEP=original',
        'RO_KEEP=changed',
        `echo "$RO_KEEP" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['original'])
    })

    it('reports the refused assignment as a failed command, not a crash', async () => {
      // A throw here would unwind the whole statement tree; bash just fails the assignment and
      // carries on to the next line.
      const output = await runScript([
        'readonly RO_CODE=1',
        'RO_CODE=2',
        `echo "code=$?" >> ${OUT}`,
        `echo still-running >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1', 'still-running'])
    })

    it('refuses unset too', async () => {
      const output = await runScript([
        'readonly RO_UNSET=here',
        'unset RO_UNSET',
        `echo "$RO_UNSET" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['here'])
    })

    it('marks an already-set name without changing it', async () => {
      const output = await runScript([
        'RO_EXISTING=before',
        'readonly RO_EXISTING',
        'RO_EXISTING=after',
        `echo "$RO_EXISTING" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['before'])
    })

    it('lists what is marked with -p', async () => {
      const output = await runScript([
        'readonly RO_LISTED=shown',
        `readonly -p >> ${OUT}`
      ].join('\n'))
      expect(output).toContain('readonly RO_LISTED="shown"')
    })

    it('rejects an invalid identifier', async () => {
      const output = await runScript([
        'readonly 9bad=x',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['code=1'])
    })
  })

  describe('declare', () => {
    it('assigns like a plain assignment', async () => {
      const output = await runScript([
        'declare DECL=value',
        `echo "$DECL" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['value'])
    })

    it('-r is readonly', async () => {
      const output = await runScript([
        'declare -r DECL_RO=fixed',
        'DECL_RO=moved',
        `echo "$DECL_RO" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['fixed'])
    })

    it('-p prints one name with its attributes', async () => {
      const output = await runScript([
        'declare -r DECL_P=locked',
        'declare PLAIN_P=loose',
        `declare -p DECL_P >> ${OUT}`,
        `declare -p PLAIN_P >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['declare -r DECL_P="locked"', 'declare -- PLAIN_P="loose"'])
    })

    it('-F lists function names', async () => {
      const output = await runScript([
        'alpha() { echo a; }',
        'beta() { echo b; }',
        `declare -F >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['declare -f alpha', 'declare -f beta'])
    })

    it('-a declares an empty array', async () => {
      const output = await runScript([
        'declare -a DECL_ARR',
        `echo "count=\${#DECL_ARR[@]}" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['count=0'])
    })

    it('typeset is the same builtin', async () => {
      const output = await runScript([
        'typeset TS=works',
        `echo "$TS" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['works'])
    })

    it('reports an unsupported attribute rather than ignoring it', async () => {
      // An integer or nameref attribute that silently did nothing would be worse than an error.
      const output = await runScript([
        'declare -i NUM=5',
        `echo "code=$?" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['code=2'])
    })

    it('accepts -x, since every variable here already reaches a child', async () => {
      const output = await runScript([
        'declare -x EXPORTED=yes',
        `echo "$EXPORTED" >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['yes'])
    })
  })
})
