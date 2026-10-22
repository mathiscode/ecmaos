import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { formatBytes, formatCall, formatOpenFlags, formatResult, wanted } from '#lib/syscall-trace.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('the formatting of a traced call', () => {
  it('names open flags the way strace does', () => {
    expect(formatOpenFlags(0)).toBe('O_RDONLY')
    expect(formatOpenFlags(0o101 | 0o1000)).toBe('O_WRONLY|O_CREAT|O_TRUNC')
    expect(formatOpenFlags(0o2 | 0o2000000)).toBe('O_RDWR|O_CLOEXEC')
  })

  it('quotes a buffer with C escapes and marks a cut', () => {
    expect(formatBytes('a"b\n\x01', 32)).toBe('"a\\"b\\n\\001"')
    expect(formatBytes('abcdefgh', 4)).toBe('"abcd"...')
  })

  it('shows a known call by the kinds of its arguments and an unknown one as given', () => {
    expect(formatCall('open', ['/etc/passwd', 0, 0], {})).toBe('open("/etc/passwd", O_RDONLY, 00)')
    expect(formatCall('kill', [12, 15], {})).toBe('kill(12, SIGTERM)')
    expect(formatCall('lseek', [3, 0, 2], {})).toBe('lseek(3, 0, SEEK_END)')
    expect(formatCall('mystery', ['x', 4], {})).toBe('mystery("x", 4)')
  })

  it('shows a result, an errno from a throw and an errno returned as a negative number', () => {
    expect(formatResult(3, undefined).text).toBe('= 3')
    expect(formatResult(undefined, { errno: 2 }).text).toMatch(/^= -1 ENOENT \(/)
    expect(formatResult(-1, undefined).text).toMatch(/^= -1 EPERM/)
  })

  it('filters by name and by set, with exclusion winning', () => {
    expect(wanted('open', { include: ['file'] })).toBe(true)
    expect(wanted('write', { include: ['file'] })).toBe(false)
    expect(wanted('open', { include: ['file'], exclude: ['open'] })).toBe(false)
    expect(wanted('read', { exclude: ['desc'] })).toBe(false)
  })
})

describe('strace', () => {
  let kernel: Kernel
  let serial = 0

  const sh = async (command: string) => {
    const base = `/tmp/st-${serial++}`
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

  it('prints the calls of a command to standard error and ends with its exit', async () => {
    const result = await sh('strace echo hi')
    expect(result.code).toBe(0)
    expect(result.out).toBe('hi\n')
    expect(result.err).toMatch(/write\(1, "hi\\n", 3\) = 3/)
    expect(result.err.trimEnd().endsWith('+++ exited with 0 +++')).toBe(true)
  }, 60000)

  it('exits with the status of the command', async () => {
    expect((await sh('strace sh -c "exit 7"')).code).toBe(7)
  }, 60000)

  it('shows a failed call with its errno', async () => {
    const result = await sh('strace cat /no/such/file')
    expect(result.err).toMatch(/stat\("\/no\/such\/file"\) = -1 ENOENT \(No such file or directory\)/)
  }, 60000)

  it('-o writes the trace to a file and leaves standard error alone', async () => {
    const result = await sh('strace -o /tmp/trace.txt echo hi')
    expect(result.err).toBe('')
    const trace = await kernel.filesystem.fs.readFile('/tmp/trace.txt', 'utf-8')
    expect(trace).toMatch(/write\(1, "hi\\n", 3\) = 3/)
    expect(trace.trimEnd().endsWith('+++ exited with 0 +++')).toBe(true)
  }, 60000)

  it('-e trace= keeps only the calls named', async () => {
    const result = await sh('strace -e trace=write echo hi')
    const calls = result.err.split('\n').filter(line => /^\w+\(/.test(line))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(line => line.startsWith('write('))).toBe(true)
  }, 60000)

  it('-s cuts a buffer short', async () => {
    const result = await sh('strace -s 2 echo abcdef')
    expect(result.err).toMatch(/write\(1, "ab"\.\.\., 7\) = 7/)
  }, 60000)

  it('-c prints a table instead of the calls', async () => {
    const result = await sh('strace -c echo hi')
    expect(result.err).toMatch(/% time\s+seconds/)
    expect(result.err).toMatch(/\bwrite\b/)
    expect(result.err).not.toMatch(/^write\(/m)
  }, 60000)

  it('-f follows the programs the command starts, and without it they are not traced', async () => {
    const without = await sh('strace ecmash -c "/bin/echo inner"')
    expect(without.err).not.toMatch(/write\(1, "inner/)
    const withFollow = await sh('strace -f -e trace=write ecmash -c "/bin/echo inner"')
    expect(withFollow.err).toMatch(/write\(1, "inner\\n"/)
  }, 60000)

  it('stops tracing when nothing reads the trace any more, and the program goes on to start its children', async () => {
    // the trace fills `head`'s lines, which leaves a program that has not written yet (its output is buffered) to
    // start its children with the pipe's write end as their stdout, and later to fail its writes as Linux's would
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/wali-ipc.wasm`)
    await kernel.filesystem.fs.writeFile('/tmp/wali-ipc', new Uint8Array(bytes), { mode: 0o755 })
    const result = await sh('strace -e trace=ipc /tmp/wali-ipc 2>&1 | head -12')
    expect(result.out.trimEnd().split('\n')).toHaveLength(12)
    expect(result.out).toMatch(/^ipc_get\("msg"/m)
  }, 60000)

  it('reports a command that is not there', async () => {
    const result = await sh('strace no-such-command')
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/strace: Can't stat 'no-such-command'/)
  }, 60000)

  it('costs an untraced program nothing it can see: it runs as before', async () => {
    expect((await sh('echo plain')).out).toBe('plain\n')
  }, 60000)

  it('traces a process that is already running until it ends', async () => {
    await kernel.shell.execute('while true; do echo tick; sleep 0.2; done > /dev/null & echo $! > /tmp/looper.pid')
    const pid = (await kernel.filesystem.fs.readFile('/tmp/looper.pid', 'utf-8')).trim()
    // the loop is a shell; trace its `sleep` children instead by attaching to the loop's current child
    await kernel.shell.execute(`sleep 30 & echo $! > /tmp/sleeper.pid`)
    const sleeper = (await kernel.filesystem.fs.readFile('/tmp/sleeper.pid', 'utf-8')).trim()
    const tracing = kernel.shell.execute(`strace -p ${sleeper} -o /tmp/attached.txt`)
    await new Promise(resolve => setTimeout(resolve, 800))
    await kernel.shell.execute(`kill ${sleeper}`)
    expect(await tracing).toBe(0)
    const trace = await kernel.filesystem.fs.readFile('/tmp/attached.txt', 'utf-8')
    expect(trace).toMatch(/\+\+\+ exited with|\+\+\+ killed by/)
    await kernel.shell.execute(`kill ${pid}`)
  }, 60000)

  it('refuses a process that is not there, and -p with a command', async () => {
    const run = async (command: string) => {
      const code = await kernel.shell.execute(`${command} 2> /tmp/p.err`)
      return { code, err: await kernel.filesystem.fs.readFile('/tmp/p.err', 'utf-8') }
    }
    const missing = await run('strace -p 99999')
    expect(missing.code).toBe(1)
    expect(missing.err).toMatch(/No such process/)
    expect((await run('strace -p 1 echo hi')).err).toMatch(/cannot be used together/)
  }, 60000)
})
