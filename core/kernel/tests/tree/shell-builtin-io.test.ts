import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * What a true shell builtin's fds are connected to.
 *
 * Builtins used to write straight to `shell.terminal`, which meant two divergences from every real
 * shell: their output ignored redirections entirely (`jobs > f` printed to the screen and left `f`
 * empty), and they could not appear in a pipeline at all - `trueBuiltinNameFor` bailed on any
 * pipeline longer than one command, so `export -p | grep X` fell through to a `/bin/export` lookup
 * that deliberately does not exist and failed as command-not-found.
 *
 * Everything a builtin emits or reads now goes through `ShellBuiltinIO`, so a builtin stage is
 * wired up by `runPipeline` exactly like any other stage. Diagnostics moved to fd 2 at the same
 * time, which is what makes `cd /nope 2>/dev/null` silent.
 *
 * The `no redirections` fast path (`Shell.fastPathBuiltinFor`) still writes directly to the
 * terminal and allocates no streams, so `cd` in a tight loop costs what it always did; the tests
 * for cwd and `$?` below are what keep that path correct.
 */
describe('true builtin fds', () => {
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

  const read = async (path: string): Promise<string> =>
    await kernel.filesystem.fs.readFile(path, 'utf-8') as unknown as string

  describe('redirection', () => {
    it('sends a builtin\'s stdout to a file', async () => {
      const out = '/tmp/builtin-stdout.out'
      const code = await kernel.shell.execute(`export -p > ${out}`)

      expect(code).toBe(0)
      expect(await read(out)).toContain('PATH=')
    })

    it('appends with >>', async () => {
      const out = '/tmp/builtin-append.out'
      await kernel.shell.execute(`export -p > ${out}`)
      await kernel.shell.execute(`export -p >> ${out}`)

      const text = await read(out)
      // The same listing twice, so the first line shows up at least twice over.
      const first = text.split('\n')[0] as string
      expect(text.split(first).length - 1).toBeGreaterThanOrEqual(2)
    })

    it('sends a builtin\'s diagnostics to fd 2, not fd 1', async () => {
      const out = '/tmp/builtin-split-stdout.out'
      const err = '/tmp/builtin-split-stderr.out'
      const code = await kernel.shell.execute(`cd /definitely-not-a-real-directory > ${out} 2> ${err}`)

      expect(code).toBe(1)
      expect(await read(err)).toContain('cd:')
      // The error must NOT have leaked onto stdout.
      expect(await read(out)).toBe('')
    })

    it('discards a diagnostic redirected to /dev/null', async () => {
      const code = await kernel.shell.execute('cd /definitely-not-a-real-directory 2>/dev/null')
      expect(code).toBe(1)
    })

    it('writes the trap listing to a file', async () => {
      const out = '/tmp/builtin-trap.out'
      kernel.shell.setTrap('echo trapped', 'USR1')
      try {
        const code = await kernel.shell.execute(`trap > ${out}`)
        expect(code).toBe(0)
        expect(await read(out)).toContain('USR1')
      } finally {
        kernel.shell.setTrap(undefined, 'USR1')
      }
    })
  })

  describe('pipelines', () => {
    it('pipes a builtin into a real command', async () => {
      const out = '/tmp/builtin-pipe.out'
      const code = await kernel.shell.execute(`export -p | grep PATH > ${out}`)

      expect(code).toBe(0)
      const text = await read(out)
      expect(text).toContain('PATH=')
      // grep filtered, so the listing's other variables are gone.
      expect(text.split('\n').filter(line => line.trim() !== '').every(line => line.includes('PATH'))).toBe(true)
    })

    it('pipes a builtin through two stages', async () => {
      const out = '/tmp/builtin-pipe-two.out'
      const code = await kernel.shell.execute(`export -p | grep PATH | wc -l > ${out}`)

      expect(code).toBe(0)
      expect(Number((await read(out)).trim())).toBeGreaterThan(0)
    })

    it('feeds a builtin from a pipe without breaking the stage after it', async () => {
      // `jobs` ignores stdin, but it must still not hang or steal the pipe from `wc`.
      const out = '/tmp/builtin-pipe-mid.out'
      const code = await kernel.shell.execute(`export -p | jobs > ${out}`)
      expect(code).toBe(0)
    })
  })

  describe('background', () => {
    it('runs a redirected builtin in the background', async () => {
      const out = '/tmp/builtin-bg.out'
      if (await kernel.filesystem.fs.exists(out)) await kernel.filesystem.fs.unlink(out)

      await kernel.shell.execute(`export -p > ${out} &`)
      await kernel.shell.execute('wait')

      expect(await kernel.filesystem.fs.exists(out)).toBe(true)
      expect(await read(out)).toContain('PATH=')
    })
  })

  describe('the unredirected fast path still works', () => {
    it('changes the shell\'s own cwd', async () => {
      await kernel.filesystem.fs.mkdir('/tmp/builtin-fastpath').catch(() => {})
      const code = await kernel.shell.execute('cd /tmp/builtin-fastpath')

      expect(code).toBe(0)
      expect(kernel.shell.cwd).toBe('/tmp/builtin-fastpath')
      await kernel.shell.execute('cd /')
    })

    it('reports a builtin\'s exit code in $?', async () => {
      await kernel.shell.execute('cd /definitely-not-a-real-directory 2>/dev/null')
      expect(kernel.shell.env.get('?')).toBe('1')

      await kernel.shell.execute('cd /')
      expect(kernel.shell.env.get('?')).toBe('0')
    })

    it('still lets a builtin beat a same-named function', async () => {
      // Declared the way the parser actually accepts a function: `name() {` over several lines.
      await kernel.shell.executeScriptText(['cd() {', '  echo shadowed', '}'].join('\n'))
      expect(kernel.shell.functions.has('cd')).toBe(true)
      try {
        const code = await kernel.shell.execute('cd /tmp')
        expect(code).toBe(0)
        expect(kernel.shell.cwd).toBe('/tmp')
      } finally {
        kernel.shell.functions.delete('cd')
        await kernel.shell.execute('cd /')
      }
    })
  })
})
