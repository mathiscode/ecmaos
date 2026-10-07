import { describe, expect, it } from 'vitest'

import { Connection, DeviceError, memoryPair, PeerError, RemoteDevice, serveDevice } from '../src/index.ts'
import type { DeviceSession } from '../src/index.ts'

const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

async function pair(session: DeviceSession, window = 256 * 1024) {
  const [a, b] = memoryPair()
  const client = new Connection(a, { role: 'client', window })
  const server = new Connection(b, { role: 'server', window })
  server.accept('device', channel => serveDevice(channel, session))
  const remote = new RemoteDevice(await client.open('device'))
  return { remote, client, server }
}

/** A device fed by `push`, which records what is written to it */
function fake() {
  const written: Uint8Array[] = []
  const waiting: Array<(chunk: Uint8Array | undefined) => void> = []
  const queue: Array<Uint8Array | undefined> = []
  let closed = 0
  const session: DeviceSession = {
    info: { kind: 'fake', read: true, write: true, speed: 9600 },
    read: () => new Promise(resolve => { const next = queue.shift(); if (next !== undefined || queue.length) resolve(next); else waiting.push(resolve) }),
    write: async data => { written.push(data) },
    control: async (op, args) => {
      if (op === 'echo') return args
      if (op === 'fail') throw new DeviceError('EINVAL', 'nope')
      throw new DeviceError('ENOSYS')
    },
    close: () => { closed++ }
  }
  const push = (chunk: Uint8Array | undefined) => { const w = waiting.shift(); if (w) w(chunk); else queue.push(chunk) }
  return { session, push, written, closed: () => closed }
}

describe('a device over a channel', () => {
  it('tells the user what the device is', async () => {
    const { session } = fake()
    const { remote } = await pair(session)
    expect(await remote.info()).toMatchObject({ kind: 'fake', read: true, write: true, speed: 9600 })
  })

  it('carries bytes both ways, in order', async () => {
    const { session, push, written } = fake()
    const { remote } = await pair(session)
    push(new Uint8Array([1, 2, 3]))
    push(new Uint8Array([4, 5]))
    await wait()
    const into = new Uint8Array(10)
    expect(remote.take(into)).toBe(5)
    expect([...into.subarray(0, 5)]).toEqual([1, 2, 3, 4, 5])
    expect(remote.write(new Uint8Array([9, 8]))).toBe(2)
    expect(remote.write(new Uint8Array([7]))).toBe(1)
    await wait()
    expect(written.map(chunk => [...chunk])).toEqual([[9, 8], [7]])
  })

  it('holds the device back when the user does not read (credit comes back only on take)', async () => {
    const { session, push } = fake()
    const { remote } = await pair(session, 1024)
    let produced = 0
    for (let index = 0; index < 20; index++) { push(new Uint8Array(512)); produced += 512 }
    await wait(30)
    // 1024 bytes of window: no more than that reaches the user until it reads
    expect(remote.available).toBeLessThanOrEqual(1024)
    expect(remote.available).toBeLessThan(produced)
    let total = 0
    for (let round = 0; round < 40 && total < produced; round++) { total += remote.take(new Uint8Array(4096)); await wait(5) }
    expect(total).toBe(produced)
  })

  it('a slow device slows the writer instead of buffering without limit', async () => {
    const { session } = fake()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const received: number[] = []
    session.write = async data => { await gate; received.push(data.length) }
    const { remote } = await pair(session, 1024)
    let accepted = 0
    for (let index = 0; index < 10; index++) accepted += remote.write(new Uint8Array(512))
    expect(accepted).toBe(1024)
    expect(remote.writable).toBe(0)
    let writable = 0
    remote.onChange = () => { writable = remote.writable }
    release()
    await wait(30)
    expect(received.reduce((sum, size) => sum + size, 0)).toBe(1024)
    expect(writable).toBeGreaterThan(0)
  })

  it('controls: replies, error codes, unknown operations', async () => {
    const { session } = fake()
    const { remote } = await pair(session)
    expect(await remote.control('echo', 1, 'two')).toEqual([1, 'two'])
    await expect(remote.control('fail')).rejects.toMatchObject({ code: 'EINVAL', message: 'nope' })
    await expect(remote.control('whatever')).rejects.toMatchObject({ code: 'ENOSYS' })
  })

  it('a device without controls says ENOSYS; one that cannot be written to refuses writes', async () => {
    const { session } = fake()
    delete session.control
    delete session.write
    const { remote } = await pair(session)
    await expect(remote.control('echo')).rejects.toMatchObject({ code: 'ENOSYS' })
    remote.write(new Uint8Array([1]))
    await remote.channel.done
    expect(remote.channel.error?.code).toBe('refused')
  })

  it('events reach the user', async () => {
    const { session } = fake()
    const { remote } = await pair(session)
    const seen: Array<[string, unknown]> = []
    remote.onEvent = (name, data) => { seen.push([name, data]) }
    session.emit!('signals', { dtr: true })
    await wait()
    expect(seen).toEqual([['signals', { dtr: true }]])
  })

  it('hot-unplug: the device ending closes the channel and fails pending calls', async () => {
    const { session, push, closed } = fake()
    const { remote } = await pair(session)
    push(undefined)
    await remote.channel.done
    expect(remote.closed).toBe(true)
    expect(closed()).toBe(1)
    await expect(remote.control('echo')).rejects.toMatchObject({ code: 'ENODEV' })
    expect(() => remote.write(new Uint8Array(1))).toThrow(/gone/)
  })

  it('a device that fails reports why; the user closing releases the device', async () => {
    const failing = fake()
    failing.session.read = async () => { throw new Error('usb cable pulled') }
    const first = await pair(failing.session)
    await first.remote.channel.done
    expect(first.remote.channel.error).toBeInstanceOf(PeerError)
    expect(first.remote.channel.error?.message).toMatch(/usb cable pulled/)

    const closing = fake()
    const second = await pair(closing.session)
    second.remote.close()
    await wait()
    expect(closing.closed()).toBe(1)
  })

  it('ignores malformed control messages by ending the channel', async () => {
    const { session } = fake()
    const { remote } = await pair(session)
    remote.channel.send({ t: 'ctl', id: 'x', op: 5, a: 1 })
    await remote.channel.done
    expect(remote.channel.error?.code).toBe('protocol')
  })
})
