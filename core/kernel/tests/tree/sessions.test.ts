import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { SessionLog, UTMP, WTMP, type SessionFs } from '#lib/sessions.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

function memoryFs(): SessionFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    exists: async path => files.has(path),
    readFile: async path => files.get(path) ?? '',
    writeFile: async (path, data) => { files.set(path, data) }
  }
}

describe('SessionLog', () => {
  it('empties utmp and marks the boot in wtmp', async () => {
    const fs = memoryFs()
    fs.files.set(UTMP, 'ghost\ttty3\t1\n')
    await new SessionLog(fs, () => 1000).boot()
    expect(fs.files.get(UTMP)).toBe('')
    expect(fs.files.get(WTMP)).toBe('boot\t~\tsystem boot\t1000\n')
  })

  it('keeps one line per console, in tty order, and replaces on su', async () => {
    const fs = memoryFs()
    let now = 1
    const log = new SessionLog(fs, () => now++)
    await log.login('root', 2)
    await log.login('alice', 10)
    await log.login('bob', 0)
    await log.login('alice', 2)
    expect(fs.files.get(UTMP)!.trim().split('\n').map(l => l.split('\t').slice(0, 2).join(' ')))
      .toEqual(['bob tty0', 'alice tty2', 'alice tty10'])
    // every login stays in the history, replaced or not
    expect(fs.files.get(WTMP)!.trim().split('\n')).toHaveLength(4)
  })
})

describe('who and last', () => {
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

  const fs = () => kernel.filesystem.fs
  const capture = async (line: string) => {
    await kernel.shell.execute(`${line} > /tmp/session.out`)
    return await fs().readFile('/tmp/session.out', 'utf-8')
  }

  it('records the boot login on tty0', async () => {
    const utmp = await fs().readFile(UTMP, 'utf-8')
    expect(utmp).toMatch(/^root\ttty0\t\d+\n$/)
  })

  it('who lists it', async () => {
    const out = await capture('who')
    expect(out).toMatch(/^root\s+tty0\s+\d{4}-\d\d-\d\d \d\d:\d\d\n$/)
    expect(await capture('who -q')).toBe('root\n# users=1\n')
  })

  it('last shows the login as still open, above the boot line', async () => {
    const out = (await capture('last')).trim().split('\n')
    expect(out[0]).toMatch(/^root\s+tty0\s.*still logged in$/)
    expect(out.some(line => /^reboot\s+system boot/.test(line))).toBe(true)
  })

  it('last -n limits the output and rejects a bad count', async () => {
    expect((await capture('last -n 1')).trim().split('\n')).toHaveLength(1)
    expect(await kernel.shell.execute('last -n x 2> /dev/null')).toBe(1)
  })
})
