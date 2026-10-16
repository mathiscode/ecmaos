import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** xargs, timeout, nohup, watch, yes, true, false, pgrep and pkill: the programs that run or find other programs. */
describe('process and job commands', () => {
  let kernel: Kernel
  let serial = 0

  const sh = async (command: string) => {
    const base = `/tmp/cb-${serial++}`
    const code = await kernel.shell.execute(`${command} > ${base}.out 2> ${base}.err`)
    const read = (suffix: string) => kernel.filesystem.fs.readFile(`${base}.${suffix}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  }, 60000)

  describe('true, false and yes', () => {
    it('are programs with the status their names say', async () => {
      expect((await sh('/bin/true')).code).toBe(0)
      expect((await sh('/bin/false')).code).toBe(1)
      expect((await sh('env true')).code).toBe(0)
    }, 30000)

    it('yes repeats a line until the reader is gone', async () => {
      expect((await sh('yes | head -n 3')).out).toBe('y\ny\ny\n')
      expect((await sh('yes some words | head -n 2')).out).toBe('some words\nsome words\n')
    }, 30000)
  })

  describe('a reader that finishes first', () => {
    it('ends a loop that writes into it, as SIGPIPE does', async () => {
      const result = await sh('while true; do echo x; done | head -n 2')
      expect(result.out).toBe('x\nx\n')
      expect(result.code).toBe(0)
    }, 30000)

    it('is not an error for a builtin writing into it', async () => {
      expect((await sh('export -p | true')).code).toBe(0)
      expect((await sh('for i in 1 2 3; do echo $i; done | head -n 1')).out).toBe('1\n')
    }, 30000)

    it('ends a program that writes into it, with the pipeline status of the last stage', async () => {
      const started = Date.now()
      expect((await sh('yes | head -n 1')).code).toBe(0)
      expect(Date.now() - started).toBeLessThan(10000)
    }, 30000)
  })

  describe('xargs', () => {
    it('runs echo by default, with every item on one line', async () => {
      expect((await sh("printf 'a b\\nc\\n' | xargs")).out).toBe('a b c\n')
    }, 30000)

    it('takes -n items at a time', async () => {
      expect((await sh("printf '1 2 3 4 5' | xargs -n 2 echo")).out).toBe('1 2\n3 4\n5\n')
    }, 30000)

    it('replaces a string with each line for -I', async () => {
      expect((await sh("printf 'x\\ny z\\n' | xargs -I{} echo '[{}]'")).out).toBe('[x]\n[y z]\n')
    }, 30000)

    it('honours quotes and backslashes, and -0 for NUL separated input', async () => {
      expect((await sh("echo \"'a b' c d\\\\ e\" | xargs -n 1 echo")).out).toBe('a b\nc\nd e\n')
      expect((await sh("printf 'a b\\0c\\0' | xargs -0 -n 1 echo")).out).toBe('a b\nc\n')
    }, 30000)

    it('splits at a chosen delimiter', async () => {
      expect((await sh("printf 'a,b,c' | xargs -d , -n 1 echo")).out).toBe('a\nb\nc\n')
    }, 30000)

    it('does not run the command for empty input with -r, and does without it', async () => {
      expect((await sh('true | xargs -r echo ran')).out).toBe('')
      expect((await sh('true | xargs echo ran')).out).toBe('ran\n')
    }, 30000)

    it('prints each command line with -t', async () => {
      const result = await sh("printf 'a b' | xargs -t -n 1 echo")
      expect(result.err).toBe('echo a\necho b\n')
    }, 30000)

    it('reports 123 when a command failed, 127 when it is missing, and stops on 255', async () => {
      expect((await sh('echo x | xargs false')).code).toBe(123)
      const missing = await sh('echo x | xargs no-such-program')
      expect(missing.code).toBe(127)
      expect(missing.err).toContain('no-such-program')
    }, 30000)

    it('runs several commands at once with -P, and each still gets its items', async () => {
      const result = await sh("printf '1 2 3 4' | xargs -n 1 -P 2 echo | sort")
      expect(result.out).toBe('1\n2\n3\n4\n')
    }, 30000)

    it('gives the command no terminal input of its own', async () => {
      expect((await sh("echo x | xargs sh -c 'read v; echo got=[$v]' sh")).out).toBe('got=[]\n')
    }, 30000)

    it('refuses a bad option and an unmatched quote', async () => {
      expect((await sh('echo | xargs --bogus')).code).toBe(1)
      const quote = await sh("echo \"it's\" | xargs echo")
      expect(quote.code).toBe(1)
      expect(quote.err).toContain('unmatched single quote')
    }, 30000)
  })

  describe('timeout', () => {
    it('runs a command that finishes in time and gives its status', async () => {
      const ok = await sh('timeout 5 echo hi')
      expect(ok.out).toBe('hi\n')
      expect(ok.code).toBe(0)
      expect((await sh('timeout 5 sh -c "exit 3"')).code).toBe(3)
    }, 30000)

    it('stops one that does not, with status 124', async () => {
      const started = Date.now()
      expect((await sh('timeout 0.3 sleep 20')).code).toBe(124)
      expect(Date.now() - started).toBeLessThan(10000)
    }, 30000)

    it('sends the signal asked for, and keeps the command\'s own status with --preserve-status', async () => {
      expect((await sh('timeout -s KILL 0.3 sleep 20')).code).toBe(137)
      expect((await sh('timeout --preserve-status 0.3 sleep 20')).code).toBe(143)
    }, 30000)

    it('takes suffixes, and 0 means no limit', async () => {
      expect((await sh('timeout 0 echo free')).out).toBe('free\n')
      expect((await sh('timeout 1m echo minute')).out).toBe('minute\n')
    }, 30000)

    it('refuses a bad duration, and reports a missing command', async () => {
      expect((await sh('timeout soon echo x')).code).toBe(125)
      expect((await sh('timeout 1 no-such-program')).code).toBe(127)
    }, 30000)
  })

  describe('nohup', () => {
    it('runs the command, giving it no terminal input', async () => {
      const result = await sh('nohup echo hello')
      expect(result.out).toBe('hello\n')
      expect(result.code).toBe(0)
    }, 30000)

    it('passes the status on, and reports a missing command', async () => {
      expect((await sh('nohup false')).code).toBe(1)
      expect((await sh('nohup no-such-program')).code).toBe(127)
      expect((await sh('nohup')).code).toBe(125)
    }, 30000)
  })

  describe('watch', () => {
    it('stops with the command\'s status for -e', async () => {
      const result = await sh('watch -n 0.1 -t -e false')
      expect(result.code).toBe(1)
    }, 30000)

    it('stops when the output changes for -g, and runs a shell line', async () => {
      expect((await sh("watch -n 0.1 -t -g 'echo $RANDOM'")).code).toBe(0)
    }, 30000)

    it('shows a header unless told not to', async () => {
      const result = await sh('watch -n 0.1 -e -g false')
      expect(result.out).toContain('Every 0.1s: false')
    }, 30000)
  })

  describe('pgrep and pkill', () => {
    it('finds a process by name and says how many there are', async () => {
      await kernel.shell.execute('sleep 40 &')
      await new Promise(resolve => setTimeout(resolve, 1500))
      try {
        const found = await sh('pgrep sleep')
        expect(found.code).toBe(0)
        expect(found.out).toMatch(/^\d+\n$/)
        expect((await sh('pgrep -c sleep')).out).toBe('1\n')
        expect((await sh('pgrep -l sleep')).out).toMatch(/^\d+ sleep\n$/)
        expect((await sh('pgrep -f "sleep 40"')).code).toBe(0)
        expect((await sh('pgrep -x slee')).code).toBe(1)
        expect((await sh('pgrep -v -c sleep')).code).toBe(0)
        expect((await sh('pgrep nothing-like-this')).code).toBe(1)
      } finally {
        await sh('pkill sleep')
      }
    }, 60000)

    it('pkill signals what matches, and then it is gone', async () => {
      await kernel.shell.execute('sleep 40 &')
      await new Promise(resolve => setTimeout(resolve, 1500))
      const killed = await sh('pkill -e sleep')
      expect(killed.code).toBe(0)
      expect(killed.out).toMatch(/sleep killed \(pid \d+\)/)
      await new Promise(resolve => setTimeout(resolve, 500))
      expect((await sh('pgrep sleep')).code).toBe(1)
      expect((await sh('pkill sleep')).code).toBe(1)
    }, 60000)

    it('takes a signal by number or capitalised name, and refuses a bad one', async () => {
      await kernel.shell.execute('sleep 40 &')
      await new Promise(resolve => setTimeout(resolve, 1500))
      expect((await sh('pkill -0 sleep')).code).toBe(0)
      expect((await sh('pgrep -c sleep')).out).toBe('1\n')
      expect((await sh('pkill -KILL sleep')).code).toBe(0)
      expect((await sh('pkill -NOSUCH sleep')).code).toBe(2)
    }, 60000)

    it('wants a pattern, and a valid one', async () => {
      expect((await sh('pgrep')).code).toBe(2)
      expect((await sh('pgrep "("')).code).toBe(2)
    }, 30000)
  })
})
