import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * `/bin/dash` is the Debian Almquist shell built to WebAssembly (`core/utils/wasm/dash/build.sh`) and run as a worker
 * program. It forks for a subshell, a command substitution, a pipeline and each command it runs, so these are
 * the fork support (Asyncify, `utils/wali/asyncify.sh`) under a program that depends on it.
 */
describe('dash', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  })

  const run = async (script: string) => {
    await kernel.filesystem.fs.writeFile('/tmp/dash.sh', script)
    const code = await kernel.shell.execute('dash /tmp/dash.sh > /tmp/dash.out 2> /tmp/dash.err')
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/dash.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/dash.err', 'utf8')
    }
  }

  it('is installed in /bin', async () => {
    expect((await kernel.filesystem.fs.stat('/bin/dash')).isFile()).toBe(true)
  })

  it('runs a command line given as an argument, and gives its status', async () => {
    const code = await kernel.shell.execute('dash -c "echo \\$((6*7)); exit 3" > /tmp/dash.out')
    expect(code).toBe(3)
    expect(await kernel.filesystem.fs.readFile('/tmp/dash.out', 'utf8')).toBe('42\n')
  }, 30000)

  it('runs a program of the system, and a pipeline of them', async () => {
    expect(await run('echo one two | tr a-z A-Z\nls /bin | wc -l | tr -d " " > /dev/null\n')).toEqual({ code: 0, out: 'ONE TWO\n', err: '' })
  }, 30000)

  it('forks a subshell that changes nothing of its parent\'s, and a command substitution', async () => {
    expect(await run('x=parent\n(x=child; echo "in $x")\necho "after $x"\ny=$(echo $x; x=lost)\necho "got $y, still $x"\n'))
      .toEqual({ code: 0, out: 'in child\nafter parent\ngot parent, still parent\n', err: '' })
  }, 30000)

  it('keeps the status of the last command and of a failed one', async () => {
    expect(await run('(exit 5); echo $?\nfalse || echo or\n/bin/true && echo and\nsh -c "exit 9"; echo $?\n'))
      .toEqual({ code: 0, out: '5\nor\nand\n9\n', err: '' })
  }, 30000)

  it('runs a loop of commands, and starts a job in the background and waits for it', async () => {
    expect(await run('n=0\nfor i in 1 2 3 4 5; do n=$((n + i)); (echo $i) > /dev/null; done\necho sum=$n\n(echo bg > /tmp/dash-bg; exit 4) &\nwait $!\necho "wait=$? $(cat /tmp/dash-bg)"\n'))
      .toEqual({ code: 0, out: 'sum=15\nwait=4 bg\n', err: '' })
  }, 30000)

  it('passes a here-document through a pipe, and a file between processes', async () => {
    expect(await run('cat <<EOF | tr a-z A-Z | tee /tmp/dash-tee\nline a\nline b\nEOF\ncat /tmp/dash-tee | wc -l | tr -d " "\n'))
      .toEqual({ code: 0, out: 'LINE A\nLINE B\n2\n', err: '' })
  }, 30000)

  // dash runs a builtin through a pointer, and Asyncify is told that call reaches fork (wasm/dash/build.sh); these are the
  // builtins that run commands, and the other places that do
  it('forks under eval, a sourced file, a function, a trap and a command prefix', async () => {
    expect(await run('eval \'echo e | tr e E\'\necho \'echo s | tr s S\' > /tmp/dash-src\n. /tmp/dash-src\nf() { (echo f | tr f F); echo "$(echo g)"; }\nf\ncommand echo c | tr c C\ntrap \'echo t | tr t T\' EXIT\nexec 3>&1\nx=$(eval \'(echo n)\')\necho "$x"\n'))
      .toEqual({ code: 0, out: 'E\nS\nF\ng\nC\nn\nT\n', err: '' })
  }, 30000)
})
