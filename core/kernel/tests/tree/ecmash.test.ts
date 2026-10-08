import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `/bin/ecmash`: the shell as a real program, driven through the kernel shell like any command. */
describe('ecmash', () => {
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
  /** Runs `script` with `ecmash -c`, capturing stdout through a file the kernel shell writes. */
  const run = async (script: string, extra = '') => {
    await fs().writeFile('/tmp/em-script', script)
    const code = await kernel.shell.execute(`ecmash ${extra} /tmp/em-script > /tmp/em-out 2> /tmp/em-err`)
    return { code, out: await fs().readFile('/tmp/em-out', 'utf-8'), err: await fs().readFile('/tmp/em-err', 'utf-8') }
  }

  it('runs a command and reports its status', async () => {
    const { code, out } = await run('echo hello; false; echo "status=$?"')
    expect(out).toBe('hello\nstatus=1\n')
    expect(code).toBe(0)
  })

  it('keeps stdout and stderr in the order they were written when both go to one file', async () => {
    // Two pipes, each pumped on its own timing, put every stderr line after the stdout ones.
    const cases: Array<[string, string]> = [
      ['echo A; echo e1 >&2; echo B; echo e2 >&2; echo C', 'A\ne1\nB\ne2\nC\n'],
      ['echo A; ls /nope; echo B', "A\nls: cannot access '/nope': No such file or directory\nB\n"]
    ]
    for (const [script, expected] of cases) {
      await fs().writeFile('/tmp/em-script', script)
      await kernel.shell.execute('ecmash /tmp/em-script > /tmp/em-both 2>&1')
      expect(await fs().readFile('/tmp/em-both', 'utf-8')).toBe(expected)
      await kernel.shell.execute('ecmash /tmp/em-script &> /tmp/em-both')
      expect(await fs().readFile('/tmp/em-both', 'utf-8')).toBe(expected)
    }
  })

  it('wires a pipeline through real pipes', async () => {
    expect((await run('echo abc | tr a-z A-Z | cat')).out).toBe('ABC\n')
  })

  it('a pipeline always reaches EOF, however the stages are timed', async () => {
    // A reader already blocked on an empty pipe used to miss the last writer closing, so this hung
    // now and then: upstream only wakes a pipe when data moves (see `lib/pipe-wakeup.ts`).
    for (let i = 0; i < 15; i++) expect((await run('echo abc | tr a-z A-Z | cat')).out).toBe('ABC\n')
  }, 60000)

  it('expands variables, arithmetic and command substitution', async () => {
    expect((await run('x=5; echo "$x $((x*2)) $(echo sub)"')).out).toBe('5 10 sub\n')
  })

  it('runs loops, conditionals and functions', async () => {
    const script = 'f() { echo "got $1"; }\nfor i in a b; do f $i; done\nif [ 1 -eq 1 ]; then echo yes; fi\n'
    expect((await run(script)).out).toBe('got a\ngot b\nyes\n')
  })

  it('redirects to a file, appends, and reads a heredoc', async () => {
    const script = 'echo one > /tmp/em-r\necho two >> /tmp/em-r\ncat < /tmp/em-r\ncat <<EOF\nhd $((1+1))\nEOF\n'
    const { out } = await run(script)
    expect(out).toBe('one\ntwo\nhd 2\n')
  })

  it('a command inherits only exported variables', async () => {
    const script = 'A=1; export B=2; env | grep -E "^(A|B)="\n'
    expect((await run(script)).out).toBe('B=2\n')
  })

  it('reports a missing command with 127', async () => {
    const { out, err } = await run('nosuchcmd\necho "s=$?"')
    expect(out).toBe('s=127\n')
    expect(err).toContain('command not found')
  })

  it('read takes one line at a time from a redirected loop', async () => {
    const script = 'printf "a\\nb\\n" > /tmp/em-in\nwhile read x; do echo "x=$x"; done < /tmp/em-in\n'
    expect((await run(script)).out).toBe('x=a\nx=b\n')
  })

  it('a pipeline stage killed by SIGINT stops the rest of the pipeline', async () => {
    // `sleep 30` dies of SIGINT; the reader after it must not be left waiting on the pipe.
    const script = 'sleep 30 | cat &\nsleep 1\nkill -INT $!\nwait\necho done\n'
    expect((await run(script)).out).toContain('done')
  })
})

describe('chsh and /etc/shells', () => {
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
  const run = async (line: string) => {
    const code = await kernel.shell.execute(`${line} > /tmp/cs-out 2> /tmp/cs-err`)
    return { code, out: await fs().readFile('/tmp/cs-out', 'utf-8'), err: await fs().readFile('/tmp/cs-err', 'utf-8') }
  }

  it('lists both shells', async () => {
    expect((await run('chsh -l')).out).toBe('/bin/ecmash\necmaos\n')
  })

  it('changes a shell through /etc/passwd and refuses one that is not listed', async () => {
    await kernel.users.add({ username: 'tester', password: 'pw1234', shell: 'ecmaos', home: '/home/tester' }, { noHome: true })
    const first = await run('chsh -s /bin/ecmash tester')
    expect(first.err).toBe('')
    expect(first.code).toBe(0)
    expect(await fs().readFile('/etc/passwd', 'utf-8')).toMatch(/^tester:x:\d+:\d+:tester:\/home\/tester:\/bin\/ecmash$/m)
    const refused = await run('chsh -s /bin/zsh tester')
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('not listed in /etc/shells')
  })

  it('$SHLVL counts up', async () => {
    await kernel.shell.execute('SHLVL=4; export SHLVL')
    await kernel.shell.execute(`ecmash -c 'echo $SHLVL' > /tmp/cs-lvl`)
    expect(await fs().readFile('/tmp/cs-lvl', 'utf-8')).toBe('5\n')
  })
})

describe('ecmash options, aliases and traps', () => {
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
    await fs().writeFile('/tmp/eo-script', script)
    const code = await kernel.shell.execute('ecmash /tmp/eo-script > /tmp/eo-out 2> /tmp/eo-err')
    return { code, out: await fs().readFile('/tmp/eo-out', 'utf-8'), err: await fs().readFile('/tmp/eo-err', 'utf-8') }
  }

  it('set -e stops at the first failure but not inside a condition or an ||', async () => {
    const { code, out } = await run('set -e\nif false; then echo no; fi\nfalse || echo recovered\necho before\nfalse\necho after\n')
    expect(out).toBe('recovered\nbefore\n')
    expect(code).toBe(1)
  })

  it('set -u fails on an unset variable', async () => {
    const { code, err } = await run('set -u\necho "$nope"\n')
    expect(code).not.toBe(0)
    expect(err).toMatch(/nope|unbound|unset/i)
  })

  it('set -x traces commands to stderr', async () => {
    expect((await run('set -x\necho hi\n')).err).toContain('+ echo hi')
  })

  it('set -o pipefail reports a failing early stage', async () => {
    const { out } = await run('false | cat\necho "a=$?"\nset -o pipefail\nfalse | cat\necho "b=$?"\n')
    expect(out).toBe('a=0\nb=1\n')
  })

  it('aliases expand the command word', async () => {
    expect((await run('alias hi="echo hello"\nhi world\n')).out).toBe('hello world\n')
  })

  it('an EXIT trap runs once on exit, including through exit', async () => {
    expect((await run("trap 'echo bye' EXIT\necho work\nexit 3\n")).out).toBe('work\nbye\n')
  })

  it('reports an unsupported option instead of ignoring it', async () => {
    const { err } = await run('set -Z\n')
    expect(err).toContain('invalid option')
  })
})

describe('head and tail take -NUMBER', () => {
  it('reads the obsolete -3 form', async () => {
    const kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    await kernel.shell.execute('seq 1 10 > /tmp/hn-in; head -3 /tmp/hn-in > /tmp/hn-h; tail -2 /tmp/hn-in > /tmp/hn-t')
    expect(await kernel.filesystem.fs.readFile('/tmp/hn-h', 'utf-8')).toBe('1\n2\n3\n')
    expect(await kernel.filesystem.fs.readFile('/tmp/hn-t', 'utf-8')).toBe('9\n10\n')
  })
})

describe('ecmash background jobs', () => {
  it('wait returns once a background job is done, and the job records its status', async () => {
    const kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    await kernel.filesystem.fs.writeFile('/tmp/bg-script', 'sleep 1 &\njobs\nwait\njobs\necho ok\n')
    await kernel.shell.execute('ecmash /tmp/bg-script > /tmp/bg-out 2>&1')
    const out = await kernel.filesystem.fs.readFile('/tmp/bg-out', 'utf-8')
    expect(out).toMatch(/\[1\]\s+Running/)
    expect(out.trim().endsWith('ok')).toBe(true)
  }, 20000)
})
