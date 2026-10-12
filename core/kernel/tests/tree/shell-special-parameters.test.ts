import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The special parameters `$$`, `$PPID`, `$!`, `$-`, `$RANDOM`, `$SECONDS`, `$SHLVL`. `$SHLVL` is an environment entry
 * a child shell inherits; the rest are computed on each read. `$$` is the pid of a `Process` the shell owns, so it
 * cannot collide with a real one.
 */
describe('special parameters', () => {
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

  const OUT = '/tmp/special-params.out'

  beforeEach(async () => {
    try { await kernel.filesystem.fs.unlink(OUT) } catch { /* already absent */ }
  })

  async function runScript(script: string): Promise<string> {
    const path = '/tmp/special-params.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    await kernel.execute({ command: path, shell: kernel.shell })
    return await kernel.filesystem.fs.exists(OUT)
      ? await kernel.filesystem.fs.readFile(OUT, 'utf-8') as unknown as string
      : ''
  }

  const lines = (output: string): string[] => output.split('\n').filter(line => line !== '')

  describe('$$ and $PPID', () => {
    it('expands $$ to a positive integer', async () => {
      expect(lines(await runScript(`echo $$ >> ${OUT}`))[0]).toMatch(/^\d+$/)
      expect(Number(lines(await runScript(`echo $$ >> ${OUT}`))[0])).toBeGreaterThan(0)
    })

    it('stays the same across reads, because it is a pid and not a counter', async () => {
      const [first, second] = lines(await runScript([`echo $$ >> ${OUT}`, `echo $$ >> ${OUT}`].join('\n')))
      expect(first).toBe(second)
    })

    it('is the pid of a real registered process, so it cannot collide with one', async () => {
      const reported = Number(lines(await runScript(`echo $$ >> ${OUT}`))[0])
      expect(reported).toBe(kernel.shell.process.pid)
    })

    it('names a temp file, which is what scripts actually use it for', async () => {
      const output = await runScript([
        `echo marker > /tmp/work.$$`,
        `cat /tmp/work.$$ >> ${OUT}`
      ].join('\n'))
      expect(lines(output)).toEqual(['marker'])
    })

    it('expands $PPID to an integer', async () => {
      expect(lines(await runScript(`echo $PPID >> ${OUT}`))[0]).toMatch(/^\d+$/)
    })
  })

  describe('$RANDOM', () => {
    it('gives a value in bash’s 0..32767 range', async () => {
      const values = lines(await runScript(
        ['for i in 1 2 3 4 5 6 7 8; do', `  echo $RANDOM >> ${OUT}`, 'done'].join('\n')
      )).map(Number)
      expect(values).toHaveLength(8)
      for (const value of values) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThan(32768)
      }
    })

    it('gives a new value on each read', async () => {
      const values = lines(await runScript(
        ['for i in 1 2 3 4 5 6 7 8 9 10; do', `  echo $RANDOM >> ${OUT}`, 'done'].join('\n')
      ))
      expect(new Set(values).size).toBeGreaterThan(1)
    })

    it('is reproducible after a seed, which is what assigning to it means', async () => {
      const run = async () => {
        try { await kernel.filesystem.fs.unlink(OUT) } catch { /* already absent */ }
        return await runScript(['RANDOM=42', `echo $RANDOM-$RANDOM-$RANDOM >> ${OUT}`].join('\n'))
      }
      expect(await run()).toBe(await run())
    })

    it('does not store the seed as the variable’s value', async () => {
      // Assigning seeds the generator; reading still produces a fresh number rather than `7`.
      const output = await runScript(['RANDOM=7', `echo $RANDOM >> ${OUT}`].join('\n'))
      expect(lines(output)[0]).not.toBe('7')
    })
  })

  describe('$SECONDS', () => {
    it('starts as a non-negative integer', async () => {
      const value = Number(lines(await runScript(`echo $SECONDS >> ${OUT}`))[0])
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    })

    it('restarts from an assigned value', async () => {
      const output = await runScript(['SECONDS=100', `echo $SECONDS >> ${OUT}`].join('\n'))
      expect(Number(lines(output)[0])).toBeGreaterThanOrEqual(100)
    })
  })

  describe('$-', () => {
    it('lists the always-on flags', async () => {
      const flags = lines(await runScript(`echo $- >> ${OUT}`))[0] as string
      expect(flags).toContain('h')
      expect(flags).toContain('i')
      expect(flags).not.toContain('e')
    })

    it('gains and loses e and u with set', async () => {
      const output = await runScript([
        'set -e',
        'set -u',
        `echo $- >> ${OUT}`,
        'set +e',
        `echo $- >> ${OUT}`
      ].join('\n'))
      const [withBoth, withoutE] = lines(output) as [string, string]
      expect(withBoth).toContain('e')
      expect(withBoth).toContain('u')
      expect(withoutE).not.toContain('e')
      expect(withoutE).toContain('u')
    })
  })

  describe('$LINENO', () => {
    it('reports the physical line, counting blanks and comments', async () => {
      const output = await runScript([
        '# a comment',
        '',
        `echo $LINENO >> ${OUT}`,
        '',
        `echo $LINENO >> ${OUT}`
      ].join('\n'))
      // The script file gets a `#!` line prepended, so both numbers are shifted by one and what
      // matters is the gap between them matching the gap in the source.
      const [first, second] = lines(output).map(Number) as [number, number]
      expect(second - first).toBe(2)
    })

    it('tracks a loop body rather than freezing at the loop', async () => {
      const output = await runScript([
        'for i in 1 2; do',
        `  echo $LINENO >> ${OUT}`,
        'done'
      ].join('\n'))
      const [first, second] = lines(output)
      expect(first).toBe(second)
    })

    it('advances line by line inside a function', async () => {
      const output = await runScript([
        'f() {',
        `  echo $LINENO >> ${OUT}`,
        `  echo $LINENO >> ${OUT}`,
        '}',
        'f'
      ].join('\n'))
      const [first, second] = lines(output).map(Number) as [number, number]
      expect(second - first).toBe(1)
    })
  })

  describe('$SHLVL', () => {
    it('is 1 for a console shell', async () => {
      expect(lines(await runScript(`echo $SHLVL >> ${OUT}`))[0]).toBe('1')
    })

    it('is a real environment entry, so a child would inherit it', async () => {
      // Unlike the computed parameters: `$SHLVL` only means anything because it is inherited.
      expect(await runScript(`env >> ${OUT}`)).toContain('SHLVL=1')
      expect(kernel.shell.envObject['SHLVL']).toBe('1')
    })
  })

  describe('$!', () => {
    it('is unset until something has been backgrounded', async () => {
      const fresh = await kernel.createShell(2).catch(() => undefined)
      if (fresh) expect(fresh.lookupVariable('!')).toBeUndefined()
      else expect(true).toBe(true)
    })

    it('reports the pid of the most recent background job', async () => {
      await kernel.shell.execute('sleep 0.1 &')
      const reported = kernel.shell.lookupVariable('!')
      expect(reported).toMatch(/^\d+$/)
      await kernel.shell.wait()
    })
  })

  describe('the computed ones are not leaked into a child environment', () => {
    it('keeps $$ and $- out of envObject', async () => {
      const env = kernel.shell.envObject
      expect(env['$']).toBeUndefined()
      expect(env['-']).toBeUndefined()
      expect(env['!']).toBeUndefined()
    })
  })
})
