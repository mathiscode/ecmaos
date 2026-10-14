import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Class } from '@zenfs/linux'
import { sessionOperations } from '@ecmaos-devices/session'
import type { DeviceSession } from '@ecmaos-devices/session'
import type { KernelDevice } from '@ecmaos/types'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `@zenfs/linux` never calls a device's `open` or `release` (there is no hook for opening a file), so a node made by
 * `sessionOperations` has to get its session some other way. These open `/dev` nodes the way callers do: through the
 * filesystem object, and from a program.
 */
const events: string[] = []
const written: number[][] = []
const errors: string[] = []
/** A device that stays up after its bytes (the default ends, as a snapshot does) */
let endless = false

const session = (): DeviceSession => {
  let sent = false
  return {
    info: { kind: 'test', read: true, write: true },
    async read() {
      if (sent) return endless ? await new Promise<undefined>(() => {}) : undefined
      sent = true
      return new TextEncoder().encode('hello')
    },
    async write(data) { written.push([...data]) },
    close() { events.push('close') }
  }
}

const fake: KernelDevice = {
  pkg: { name: 'fakesession', version: '0.0.0', description: '' },
  cli: async () => 0,
  getDrivers: async () => [{
    name: 'fakeout',
    major: 0,
    minor: 2,
    class: new Class('fakesession'),
    ops: sessionOperations({ open: async () => ({ info: { kind: 'test', read: false, write: true }, async write(data) { written.push([...data]) }, close() {} }), idleMs: 150 })
  }, {
    name: 'fakenode',
    major: 0,
    minor: 1,
    class: new Class('fakesession'),
    ops: sessionOperations({ open: async () => { events.push('open'); return session() }, idleMs: 150 })
  }]
} as unknown as KernelDevice

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('a session node opened through the filesystem object', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      devices: { fakesession: fake }
    })
    await kernel.boot()
  })

  afterAll(() => { events.length = 0 })

  it('opens the session when read, gives its bytes, and closes it once it is left alone', async () => {
    events.length = 0
    const handle = await kernel.filesystem.fs.open('/dev/fakenode', 'r')
    // The file system reports a device read as the whole length asked for, so what arrived is told by the bytes
    const buffer = new Uint8Array(5)
    for (let tries = 0; tries < 100 && !buffer[0]; tries++) {
      await handle.read(buffer, 0, 5, 0)
      if (!buffer[0]) await sleep(20)
    }
    expect(new TextDecoder().decode(buffer)).toBe('hello')
    expect(events).toEqual(['open'])
    await handle.close()
    await sleep(600)
    expect(events).toEqual(['open', 'close'])
  })

  it('takes a write to the device', async () => {
    events.length = 0
    written.length = 0
    endless = true
    const handle = await kernel.filesystem.fs.open('/dev/fakenode', 'w')
    for (let tries = 0; tries < 100 && !written.length; tries++) {
      try { await handle.write(new Uint8Array([1, 2, 3]), 0, 3, 0) } catch (error) { errors.push(String(error)) }
      if (!written.length) await sleep(20)
    }
    await handle.close()
    endless = false
    expect({ written, errors: [...new Set(errors)] }).toEqual({ written: [[1, 2, 3]], errors: expect.any(Array) })
    await sleep(500)
    expect(events.filter(event => event === 'open')).toHaveLength(1)
    expect(events.filter(event => event === 'close')).toHaveLength(1)
  })

  it('gives a program the bytes, and the next open gets a new session', async () => {
    events.length = 0
    await kernel.shell.execute('cat /dev/fakenode > /tmp/session-out 2> /tmp/session-err')
    expect([await kernel.filesystem.fs.readFile('/tmp/session-out', 'utf8'), await kernel.filesystem.fs.readFile('/tmp/session-err', 'utf8'), events]).toEqual(['hello', '', ['open', 'close']])
    await sleep(50)
    expect(events).toEqual(['open', 'close'])
    await kernel.shell.execute('cat /dev/fakenode > /tmp/session-out2')
    expect(await kernel.filesystem.fs.readFile('/tmp/session-out2', 'utf8')).toBe('hello')
    expect(events.filter(event => event === 'open')).toHaveLength(2)
  })

  it('takes a shell redirect as it comes, waiting for a session that is still opening, and carries on', async () => {
    await sleep(500)
    events.length = 0
    written.length = 0
    endless = true
    await kernel.shell.execute('echo hi > /dev/fakenode; echo after > /tmp/session-after')
    endless = false
    expect(written.flat()).toEqual([104, 105, 10])
    expect(await kernel.filesystem.fs.readFile('/tmp/session-after', 'utf8')).toBe('after\n')
  })

  it('writes to a device that has nothing to read, which does not end and reads as an empty file', async () => {
    written.length = 0
    await kernel.shell.execute('echo out > /dev/fakeout; echo after > /tmp/session-after2; cat /dev/fakeout > /tmp/session-empty')
    expect(written.flat()).toEqual([111, 117, 116, 10])
    expect(await kernel.filesystem.fs.readFile('/tmp/session-after2', 'utf8')).toBe('after\n')
    expect(await kernel.filesystem.fs.readFile('/tmp/session-empty', 'utf8')).toBe('')
  })

  it('fails only the command whose redirect target refuses the write, and carries on', async () => {
    await kernel.shell.execute('echo hi > /dev/full; echo "status=$?" > /tmp/session-full')
    expect(await kernel.filesystem.fs.readFile('/tmp/session-full', 'utf8')).toBe('status=1\n')
  })
})
