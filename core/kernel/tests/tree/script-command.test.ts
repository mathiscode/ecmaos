import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `script` records a session on a pty of its own; `scriptreplay` plays it back, from a typescript or an asciicast */
describe('script and scriptreplay', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  }, 60_000)

  it('runs a command on a pty and writes the typescript around what it printed', async () => {
    const result = await run("script -c 'tty; echo recorded-$((6*7))' /tmp/ts < /dev/null")
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/^Script started, output log file is '\/tmp\/ts'\.\n/)
    expect(result.out).toContain('recorded-42')
    expect(result.out).toMatch(/Script done\.\n$/)
    const typescript = await read('/tmp/ts')
    expect(typescript).toMatch(/^Script started on \d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d \[COMMAND="tty; echo recorded-\$\(\(6\*7\)\)" TERM="[^"]+" TTY="\/dev\/pts\/\d+" COLUMNS="\d+" LINES="\d+"\]\n/)
    // the command's terminal is the pty, and its newlines come out of the pty's line discipline as CR LF
    expect(typescript).toMatch(/\/dev\/pts\/\d+\r\nrecorded-42\r\n/)
    expect(typescript).toMatch(/\nScript done on .* \[COMMAND_EXIT_CODE="0"\]\n$/)
  }, 60_000)

  it('-q is quiet, -e returns the command\'s status, and -a appends', async () => {
    const failed = await run('script -q -e -c "exit 3" /tmp/ts-q < /dev/null')
    expect(failed.code).toBe(3)
    expect(failed.out).toBe('')
    expect((await run('script -q -c "exit 3" /tmp/ts-q < /dev/null')).code).toBe(0)
    // the second run, without -a, started the file again
    await run('script -q -a -c "echo second" /tmp/ts-q < /dev/null')
    expect((await read('/tmp/ts-q')).match(/Script started on/g)).toHaveLength(2)
  }, 60_000)

  it('writes timing that scriptreplay plays the typescript back with', async () => {
    await run('script -q -T /tmp/timing -c "echo one; sleep 0.2; echo two" /tmp/ts-t < /dev/null')
    const timing = (await read('/tmp/timing')).trim().split('\n')
    expect(timing.length).toBeGreaterThan(0)
    for (const line of timing) expect(line).toMatch(/^\d+\.\d{6} \d+$/)
    const replay = await run('scriptreplay -t /tmp/timing /tmp/ts-t')
    expect(replay.code).toBe(0)
    expect(replay.out).toBe('one\r\ntwo\r\n')
    expect((await run('scriptreplay /tmp/timing /tmp/ts-t 4')).out).toBe('one\r\ntwo\r\n')
    await run('script -q -m advanced -T /tmp/timing-a -c "echo adv" /tmp/ts-a < /dev/null')
    expect(await read('/tmp/timing-a')).toMatch(/^O \d+\.\d{6} \d+$/m)
    expect((await run('scriptreplay -T /tmp/timing-a -O /tmp/ts-a')).out).toBe('adv\r\n')
  }, 60_000)

  it('--cast records an asciicast that scriptreplay plays', async () => {
    const result = await run("script -q --cast /tmp/session.cast -c 'echo cast-$((2+3))' < /dev/null")
    expect(result.code).toBe(0)
    const [header, ...events] = (await read('/tmp/session.cast')).trim().split('\n').map(line => JSON.parse(line))
    expect(header).toMatchObject({ version: 2, width: expect.any(Number), height: expect.any(Number), timestamp: expect.any(Number), command: 'echo cast-$((2+3))' })
    expect(events.every(event => Array.isArray(event) && typeof event[0] === 'number' && event[1] === 'o')).toBe(true)
    expect(events.map(event => event[2]).join('')).toBe('cast-5\r\n')
    expect((await run('scriptreplay /tmp/session.cast')).out).toBe('cast-5\r\n')
    expect((await run('scriptreplay --cast /tmp/session.cast -d 10')).out).toBe('cast-5\r\n')
    // version 3: each event's time is the time since the one before
    await fs().writeFile('/tmp/v3.cast', '{"version":3,"term":{"cols":80,"rows":24}}\n[0.1,"o","a"]\n[0.1,"m",""]\n[0.1,"o","b\\r\\n"]\n')
    expect((await run('scriptreplay /tmp/v3.cast')).out).toBe('ab\r\n')
  }, 60_000)
})
