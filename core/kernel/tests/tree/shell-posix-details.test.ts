import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('Shell details found by comparing with bash', { timeout: 120000 }, () => {
  let kernel: Kernel
  let serial = 0
  const fs = () => kernel.filesystem.fs

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  /** Runs a script as a group so its output lands in files whatever the lines hold */
  async function run(script: string) {
    const base = `/tmp/details${++serial}`
    const code = await kernel.shell.execute(`{ ${script}\n} >${base}.out 2>${base}.err`)
    const read = async (path: string) => (await fs().readFile(path, 'utf-8')) as string
    return { code, out: await read(`${base}.out`), err: await read(`${base}.err`) }
  }

  it('fails a command with an arithmetic error and skips the rest of its line', async () => {
    const r = await run('echo $((1/0)); echo same-line\necho next-line\nx=$((2/0)); echo skipped\necho last')
    expect(r.out).toBe('next-line\nlast\n')
    expect(r.err).toBe('ecmaos: 1/0: division by 0 (error token is "0")\necmaos: 2/0: division by 0 (error token is "0")\n')
  })

  it('names the expression once when let fails', async () => {
    expect((await run('let "y=1/0"')).err).toBe('ecmaos: let: y=1/0: division by 0 (error token is "0")\n')
  })

  it('runs the command of exec and ends the shell with its status', async () => {
    expect((await run('exec echo replaced\necho notreached')).out).toBe('replaced\n')
    expect((await run('( exec echo sub ); echo main')).out).toBe('sub\nmain\n')
    expect((await run('f() { exec sh -c "exit 3"; }; f; echo notreached')).out).toBe('')
    expect(await kernel.shell.execute('( exec sh -c "exit 3" )')).toBe(3)
  })

  it('says why wait refuses a pid or a job it does not own', async () => {
    const pid = await run('wait 99999; echo rc=$?')
    expect(pid.out).toBe('rc=127\n')
    expect(pid.err).toBe('ecmaos: wait: pid 99999 is not a child of this shell\n')
    expect((await run('wait %9; echo rc=$?')).err).toBe('ecmaos: wait: %9: no such job\n')
  })

  it('lets kill take a job spec', async () => {
    const r = await run('sleep 30 &\nkill %%\nwait %%; echo rc=$?')
    expect(r.out).toBe('rc=143\n')
  })

  it('pads the job status to the same column as bash', async () => {
    const r = await run('sleep 30 &\njobs\nkill %%; wait')
    expect(r.out.split('\n').find(line => line.includes('Running'))).toMatch(/^\[\d+\][+-] {2}Running {20}sleep 30 &$/)
  })

  it('expands ~user to that user\'s home', async () => {
    expect((await run('echo ~root ~root/x ~nosuchuser')).out).toBe('/root /root/x ~nosuchuser\n')
  })

  it('prints what came before a bad printf conversion, names the character and fails', async () => {
    const a = await run('printf "a%yb\\n" 1; echo rc=$?')
    expect(a.out).toBe('arc=1\n')
    expect(a.err).toBe("ecmaos: printf: `y': invalid format character\n")
    const b = await run('printf "x%5%|\\n"; echo rc=$?')
    expect(b.out).toBe('xrc=1\n')
    expect(b.err).toBe("ecmaos: printf: `%': invalid format character\n")
  })

  it('calls a job that a signal ended by the signal\'s name', async () => {
    const r = await run('sleep 30 &\nkill %%\nwait\njobs')
    expect(r.out).toContain('Terminated')
  })

  it('starts a script\'s messages with its name and line, as bash does', async () => {
    const r = await run("printf 'echo a\\nnosuchcmd\\ncd /nowhere\\nf() {\\n  nosuchcmd2\\n}\\nf\\n' > s.sh; chmod +x s.sh; ./s.sh; echo rc=$?")
    expect(r.out).toBe('a\nrc=127\n')
    expect(r.err.split('\n')).toEqual([
      './s.sh: line 2: nosuchcmd: command not found',
      './s.sh: line 3: cd: /nowhere: No such file or directory',
      './s.sh: line 5: nosuchcmd2: command not found',
      ''
    ])
  })

  it('applies exec 2>&1 inside a block to what follows it, over the block\'s own redirection', async () => {
    const r = await run('( exec 2>&1; echo to-err >&2 ); echo after >&2')
    expect(r.out).toBe('to-err\n')
    expect(r.err).toBe('after\n')
  })

  it('says no such job for a kill %spec that names nothing', async () => {
    const r = await run('kill %77; echo rc=$?'); expect([r.out, r.err]).toEqual(['rc=1\n', 'kill: %77: no such job\n'])
  })

  it('does the same in ecmash: ~user and a script\'s name and line in its messages', async () => {
    expect((await run("ecmash -c 'echo ~root ~root/x ~nosuchuser'")).out).toBe('/root /root/x ~nosuchuser\n')
    const r = await run("printf 'echo a\\nnosuchcmd\\n' > e.sh; ecmash ./e.sh; echo rc=$?")
    expect(r.out).toBe('a\nrc=127\n')
    expect(r.err).toBe('./e.sh: line 2: nosuchcmd: command not found\n')
  })

  it('runs a script with no #! line from ecmash, and takes job specs and arithmetic errors like the kernel shell', async () => {
    const r = await run("printf 'echo \"args: $1\"\\nnosuchcmd\\n' > n.sh; chmod +x n.sh; ecmash -c './n.sh x; echo rc=$?; echo $((1/0)); echo skipped'")
    expect(r.out).toBe('args: x\nrc=127\n')
    expect(r.err).toBe('./n.sh: line 2: nosuchcmd: command not found\necmash: 1/0: division by 0 (error token is "0")\n')
    const k = await run("ecmash -c 'sleep 30 & kill %1; wait %1; echo rc=$?'")
    expect(k.out).toBe('rc=143\n')
  })
})
