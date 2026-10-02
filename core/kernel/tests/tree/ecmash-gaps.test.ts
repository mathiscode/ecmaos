import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** The `ecmash` features that used to be missing: arrays, subshells, process substitution, traps. */
describe('ecmash: arrays, subshells, process substitution, traps', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  const fs = () => kernel.filesystem.fs
  const run = async (script: string) => {
    await fs().writeFile('/tmp/emg-script', script)
    const code = await kernel.shell.execute('ecmash /tmp/emg-script > /tmp/emg-out 2> /tmp/emg-err')
    return { code, out: await fs().readFile('/tmp/emg-out', 'utf-8'), err: await fs().readFile('/tmp/emg-err', 'utf-8') }
  }

  describe('arrays', () => {
    it('assigns, indexes and expands a literal', async () => {
      const { out } = await run('a=(x "y z" w)\necho "${a[1]}" ${#a[@]}\nfor v in "${a[@]}"; do echo "<$v>"; done')
      expect(out).toBe('y z 3\n<x>\n<y z>\n<w>\n')
    })

    it('appends, assigns an element and unsets one', async () => {
      const { out } = await run('a=(1 2)\na+=(3)\na[5]=9\nunset a[0]\necho "${a[@]}"\nunset a\necho "[${a[@]}]"')
      expect(out).toBe('2 3 9\n[]\n')
    })

    it('takes a command substitution inside the literal, and a command after it', async () => {
      const { out } = await run('a=($(echo p q)); echo "${a[0]}-${a[1]}"')
      expect(out).toBe('p-q\n')
    })

    it('declare -a makes an empty array and accepts a literal', async () => {
      const { out } = await run('declare -a e\necho "${#e[@]}"\ndeclare -a f=(1 2 3)\necho "${#f[@]}"')
      expect(out).toBe('0\n3\n')
    })
  })

  describe('subshells', () => {
    it('keeps variables, functions and the directory inside', async () => {
      const { out } = await run('x=1\nf() { echo outer; }\n(\n  x=2\n  cd /tmp\n  f() { echo inner; }\n  f\n  echo "$x $PWD"\n)\nf\necho "$x"; pwd')
      expect(out).toBe('inner\n2 /tmp\nouter\n1\n/root\n')
    })

    it('exit inside ends only the subshell, and sets $?', async () => {
      const { out } = await run('(echo in; exit 3; echo no)\necho "after $?"')
      expect(out).toBe('in\nafter 3\n')
    })

    it('takes a redirection, on one line and across lines', async () => {
      const { out } = await run('(echo a; echo b) > /tmp/emg-sub\n(\n  echo c\n  echo d\n) >> /tmp/emg-sub\ncat /tmp/emg-sub')
      expect(out).toBe('a\nb\nc\nd\n')
    })

    it('set -e inside does not leak out', async () => {
      const { out } = await run('(set -e; false; echo no)\necho "still here"')
      expect(out).toBe('still here\n')
    })

    it('takes one inside a list', async () => {
      const { out, code } = await run('(echo a) && echo b')
      expect(out).toBe('a\nb\n')
      expect(code).toBe(0)
    })
  })

  describe('process substitution', () => {
    it('<(cmd) is a readable path', async () => {
      expect((await run('cat <(echo hello)')).out).toBe('hello\n')
    })

    it('diff compares two commands', async () => {
      await fs().writeFile('/tmp/emg-a', 'one\ntwo\n')
      await fs().writeFile('/tmp/emg-b', 'one\nthree\n')
      const { out } = await run('diff <(cat /tmp/emg-a) <(cat /tmp/emg-b)')
      expect(out).toContain('two')
      expect(out).toContain('three')
    })

    it('feeds a loop: done < <(cmd)', async () => {
      const { out } = await run('while read l; do echo "got $l"; done < <(printf "x\\ny\\n")')
      expect(out).toBe('got x\ngot y\n')
    })

    it('>(cmd) receives the output once the command finished', async () => {
      await fs().rm('/tmp/emg-sink', { force: true })
      await run('echo captured | tee >(cat > /tmp/emg-sink) > /dev/null')
      expect(await fs().readFile('/tmp/emg-sink', 'utf-8')).toBe('captured\n')
    })

    it('leaves no temporary files behind', async () => {
      await run('cat <(echo x) >(cat) > /dev/null')
      expect((await fs().readdir('/tmp')).filter(name => name.startsWith('.ecmash-procsub-'))).toEqual([])
    })
  })

  describe('traps', () => {
    it('ERR runs after a failing command, not after a tested one', async () => {
      const { out } = await run("trap 'echo err' ERR\nfalse\nif false; then :; fi\ntrue || false\necho done")
      expect(out).toBe('err\ndone\n')
    })

    it('a signal with a trap runs it between commands', async () => {
      const { out } = await run("trap 'echo got-usr1' USR1\nkill -USR1 $$\necho after")
      expect(out).toBe('got-usr1\nafter\n')
    })

    it('a trap on a signal it does not know is refused', async () => {
      const { err, code } = await run("trap 'echo x' DEBUG")
      expect(err).toContain('unsupported signal')
      expect(code).not.toBe(0)
    })

    it('trap - removes a trap', async () => {
      const { out } = await run("trap 'echo err' ERR\ntrap - ERR\nfalse\necho done")
      expect(out).toBe('done\n')
    })
  })

  describe('jobs', () => {
    it('jobs lists a background job, wait %1 returns its status, and disown drops it', async () => {
      const { out } = await run('sleep 0.2 &\njobs\nwait %1\necho "st=$?"\nsleep 5 &\ndisown %2\njobs\necho end')
      expect(out).toContain('Running')
      expect(out).toContain('st=0')
      expect(out.endsWith('end\n')).toBe(true)
    })
  })

  describe('read -t, set -u and PIPESTATUS', () => {
    it('read -t gives up on a silent pipe with status 142, and still reads a ready one', async () => {
      const { out } = await run('sleep 1 | read -t 0.2 a; echo "late=$?"\necho hi | read -t 5 b; echo "ready=$?"\necho "$b"')
      expect(out).toContain('late=142')
      expect(out).toContain('ready=0')
    })

    it('set -u ends a script on an unset variable, with status 1', async () => {
      const { code, out, err } = await run('set -u\necho before\necho $nope\necho after')
      expect(out).toBe('before\n')
      expect(err).toContain('nope: unbound variable')
      expect(code).toBe(1)
    })

    it('PIPESTATUS holds every stage', async () => {
      const { out } = await run('true | false | true\necho "${PIPESTATUS[@]}"\nfalse | true\necho "${PIPESTATUS[@]}"')
      expect(out).toBe('0 1 0\n1 0\n')
    })

    it('an EXIT trap sees the exit status as $?', async () => {
      const { out, code } = await run('trap \'echo "st=$?"\' EXIT\nexit 5')
      expect(out).toBe('st=5\n')
      expect(code).toBe(5)
    })

    it('reads end of file from /dev/null', async () => {
      const { out } = await run('cat < /dev/null\necho "cat=$?"\nread x < /dev/null\necho "read=$?"')
      expect(out).toBe('cat=0\nread=1\n')
    })
  })
})
