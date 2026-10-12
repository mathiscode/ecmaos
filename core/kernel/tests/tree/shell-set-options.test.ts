import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The `set` options beyond the three that existed (`-e`, `-u`, `-o pipefail`): `-x`, `-f`, `-C`,
 * `-v`, the `-o` long names, letter clusters like `set -eux`, and `set --` for the positional
 * parameters.
 *
 * `runSet` previously accepted exactly `-e`, `+e`, `-u`, `+u` and `-o pipefail` and reported
 * everything else as unsupported, so a script opening with `set -euo pipefail` - the single most
 * common first line in shell scripts - failed on the cluster.
 */
describe('set options', () => {
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

  const OUT = '/tmp/set-opts.out'
  const ERR = '/tmp/set-opts.err'

  beforeEach(async () => {
    for (const path of [OUT, ERR]) {
      try { await kernel.filesystem.fs.unlink(path) } catch { /* already absent */ }
    }
    for (const flag of ['errexit', 'nounset', 'pipefail', 'xtrace', 'noglob', 'noclobber', 'verbose'] as const) {
      kernel.shell.applyShellOption(flag, false)
    }
    // Scripts run in the kernel's own long-lived shell, so a `PS4` one test sets would prefix every
    // later test's trace.
    kernel.shell.env.delete('PS4')
  })

  async function runScript(script: string): Promise<number> {
    const path = '/tmp/set-opts.sh'
    await kernel.filesystem.fs.writeFile(path, `#!ecmaos:bin:script:test\n${script}`)
    return await kernel.execute({ command: path, shell: kernel.shell })
  }

  const read = async (path: string): Promise<string> => await kernel.filesystem.fs.exists(path)
    ? await kernel.filesystem.fs.readFile(path, 'utf-8') as unknown as string
    : ''

  /**
   * Everything the terminal was told to write while `script` ran.
   *
   * `-x` and `-v` write to the *shell's* stderr, not the running command's, so `cmd 2>f` does not
   * capture them - exactly as in bash, where the trace still reaches the screen. The terminal is
   * therefore the only place to observe them.
   */
  async function captureTerminal(script: string): Promise<string> {
    const write = vi.spyOn(kernel.terminal, 'write')
    try {
      await runScript(script)
      return write.mock.calls.map(call => String(call[0])).join('')
    } finally {
      write.mockRestore()
    }
  }

  describe('letter clusters and long names', () => {
    it('accepts `set -euo pipefail`, the standard script preamble', async () => {
      const code = await runScript([
        'set -euo pipefail',
        `echo ok > ${OUT}`
      ].join('\n'))
      expect(code).toBe(0)
      expect(await read(OUT)).toBe('ok\n')
      expect(kernel.shell.shellOptions.errexit).toBe(true)
      expect(kernel.shell.shellOptions.nounset).toBe(true)
      expect(kernel.shell.shellOptions.pipefail).toBe(true)
    })

    it('turns a cluster back off with +', async () => {
      await runScript(['set -eu', 'set +eu'].join('\n'))
      expect(kernel.shell.shellOptions.errexit).toBe(false)
      expect(kernel.shell.shellOptions.nounset).toBe(false)
    })

    it('accepts the long name for a letter flag', async () => {
      await runScript('set -o xtrace')
      expect(kernel.shell.shellOptions.xtrace).toBe(true)
      await runScript('set +o xtrace')
      expect(kernel.shell.shellOptions.xtrace).toBe(false)
    })

    it('rejects an unknown letter and an unknown long name', async () => {
      expect(await runScript('set -Z')).toBe(2)
      expect(await runScript('set -o nonsense')).toBe(2)
    })
  })

  describe('set -o listing', () => {
    it('lists every option with its state', async () => {
      await runScript(['set -x', `set -o > ${OUT}`].join('\n'))
      const listing = await read(OUT)
      expect(listing).toMatch(/xtrace\s+on/)
      expect(listing).toMatch(/errexit\s+off/)
      expect(listing).toMatch(/noclobber\s+off/)
      expect(listing).toMatch(/pipefail\s+off/)
    })
  })

  describe('set -x (xtrace)', () => {
    it('prints each command to stderr behind $PS4', async () => {
      const output = await captureTerminal(['set -x', 'echo traced > /dev/null'].join('\n'))
      expect(output).toContain('+ echo traced')
    })

    it('shows the expanded arguments, which is the point', async () => {
      const output = await captureTerminal(['name=world', 'set -x', 'echo hello $name > /dev/null'].join('\n'))
      expect(output).toContain('+ echo hello world')
    })

    it('honors a custom $PS4', async () => {
      const output = await captureTerminal(['PS4=">> "', 'set -x', 'echo x > /dev/null'].join('\n'))
      expect(output).toContain('>> echo x')
    })

    it('traces a builtin too', async () => {
      const output = await captureTerminal(['set -x', 'cd /tmp'].join('\n'))
      expect(output).toContain('+ cd /tmp')
    })
  })

  describe('set -f (noglob)', () => {
    it('leaves a pattern literal', async () => {
      await runScript([
        'rm -rf /tmp/noglob-root',
        'mkdir -p /tmp/noglob-root',
        'touch /tmp/noglob-root/a.txt',
        'cd /tmp/noglob-root',
        'set -f',
        `echo *.txt > ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('*.txt\n')
    })

    it('still globs with +f', async () => {
      await runScript([
        'cd /tmp/noglob-root',
        'set -f',
        'set +f',
        `echo *.txt > ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('a.txt\n')
    })
  })

  describe('set -C (noclobber)', () => {
    it('refuses to truncate an existing file', async () => {
      await runScript([
        'echo original > /tmp/noclobber.txt',
        'set -C',
        'echo replaced > /tmp/noclobber.txt',
        `cp /tmp/noclobber.txt ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('original\n')
    })

    it('still creates a file that does not exist', async () => {
      await runScript([
        'rm -f /tmp/noclobber-new.txt',
        'set -C',
        'echo fresh > /tmp/noclobber-new.txt',
        `cp /tmp/noclobber-new.txt ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('fresh\n')
    })

    it('still appends with >>', async () => {
      await runScript([
        'echo one > /tmp/noclobber-append.txt',
        'set -C',
        'echo two >> /tmp/noclobber-append.txt',
        `cp /tmp/noclobber-append.txt ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('one\ntwo\n')
    })

    it('lets >| override it, which is the whole reason that operator exists', async () => {
      await runScript([
        'echo original > /tmp/noclobber-force.txt',
        'set -C',
        'echo forced >| /tmp/noclobber-force.txt',
        `cp /tmp/noclobber-force.txt ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('forced\n')
    })

    it('>| behaves like > when noclobber is off', async () => {
      await runScript([
        'echo original > /tmp/noclobber-off.txt',
        'echo replaced >| /tmp/noclobber-off.txt',
        `cp /tmp/noclobber-off.txt ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('replaced\n')
    })
  })

  describe('set -v (verbose)', () => {
    it('echoes each line of input to stderr', async () => {
      const output = await captureTerminal(['set -v', 'echo hello > /dev/null'].join('\n'))
      expect(output).toContain('echo hello > /dev/null')
    })
  })

  describe('set -- ', () => {
    it('replaces the positional parameters', async () => {
      await runScript([
        'set -- alpha beta gamma',
        `echo "$# $1 $3" > ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('3 alpha gamma\n')
    })

    it('clears them when given nothing', async () => {
      await runScript([
        'set -- a b',
        'set --',
        `echo "count=$#" > ${OUT}`
      ].join('\n'))
      expect(await read(OUT)).toBe('count=0\n')
    })
  })
})
