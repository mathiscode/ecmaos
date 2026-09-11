import { describe, expect, it } from 'vitest'

import { createPipe } from '#lib/pipe.ts'
import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'

/**
 * `createPipe` is the Tier-1 prototype for U7 (pipe/poll): a ring buffer exposed as two
 * `FileOperations` ends, the same shape `@zenfs/linux`'s device drivers already implement.
 *
 * It deliberately does not mint real numeric fds yet -- that bridge (`toFD`/a process fd table)
 * belongs to the `processes` branch, once a real `Process`/`Thread` exists to own descriptors.
 * Everything here is exercised directly against the `FileOperations` surface, which is exactly
 * what a future `pipe`/`pipe2` syscall handler will call once it has fds to hand back.
 */
describe('createPipe', () => {
  function readInto(pipe: ReturnType<typeof createPipe>, length: number) {
    const buffer = new Uint8Array(length)
    const n = pipe.readEnd.read?.(pipe.readFile, buffer, 0, length)
    return { n, buffer }
  }

  it('delivers bytes written on the write end to a read on the read end, in order', async () => {
    const pipe = createPipe()
    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('hello'), 0)

    const { n, buffer } = readInto(pipe, 5)
    expect(n).toBe(5)
    expect(new TextDecoder().decode(buffer)).toBe('hello')
  })

  it('returns a short read when less is buffered than requested', () => {
    const pipe = createPipe()
    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('hi'), 0)

    const { n, buffer } = readInto(pipe, 64)
    expect(n).toBe(2)
    expect(new TextDecoder().decode(buffer.subarray(0, n as number))).toBe('hi')
  })

  it('preserves write order across multiple writes larger than one read', () => {
    const pipe = createPipe()
    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('abc'), 0)
    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('def'), 0)

    const first = readInto(pipe, 4)
    expect(new TextDecoder().decode(first.buffer.subarray(0, first.n as number))).toBe('abcd')

    const second = readInto(pipe, 4)
    expect(new TextDecoder().decode(second.buffer.subarray(0, second.n as number))).toBe('ef')
  })

  it('reports EPOLLOUT but not EPOLLIN while empty, and EPOLLIN once written', () => {
    const pipe = createPipe()
    expect(pipe.readEnd.poll?.(pipe.readFile)).toBe(0)
    expect(pipe.writeEnd.poll?.(pipe.writeFile)! & EPOLLOUT).toBeTruthy()

    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('x'), 0)
    expect(pipe.readEnd.poll?.(pipe.readFile)! & EPOLLIN).toBeTruthy()
  })

  it('wakes a waiter on the read queue once data is written', async () => {
    const pipe = createPipe()
    const queue = pipe.readEnd.poll_wait?.(pipe.readFile)
    expect(queue).toBeDefined()

    let woken = false
    const waited = queue!.wait().then(() => { woken = true })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(woken).toBe(false)

    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('go'), 0)
    await waited
    expect(woken).toBe(true)
  })

  it('returns 0 (EOF) from a read once the write end is closed and the buffer is drained', () => {
    const pipe = createPipe()
    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('x'), 0)
    pipe.writeEnd.release?.(pipe.writeFile)

    const first = readInto(pipe, 1)
    expect(first.n).toBe(1)

    const second = readInto(pipe, 1)
    expect(second.n).toBe(0)
  })

  it('wakes a blocked reader with EOF (0) when the write end closes while it is waiting', async () => {
    const pipe = createPipe()
    const queue = pipe.readEnd.poll_wait?.(pipe.readFile)

    const waited = queue!.wait()
    await new Promise(resolve => setTimeout(resolve, 10))
    pipe.writeEnd.release?.(pipe.writeFile)
    await waited

    const { n } = readInto(pipe, 1)
    expect(n).toBe(0)
  })

  it('reports EPOLLIN once the write end closes, so a waiting poll does not hang forever', () => {
    const pipe = createPipe()
    pipe.writeEnd.release?.(pipe.writeFile)
    expect(pipe.readEnd.poll?.(pipe.readFile)! & EPOLLIN).toBeTruthy()
  })

  it('throws EPIPE writing to a pipe whose read end has already closed', () => {
    const pipe = createPipe()
    pipe.readEnd.release?.(pipe.readFile)
    expect(() => pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('x'), 0)).toThrow(expect.objectContaining({ code: 'EPIPE' }))
  })

  it('reports EPOLLOUT (never blocks a write) once the read end has closed, since the write will throw instead', () => {
    const pipe = createPipe()
    pipe.readEnd.release?.(pipe.readFile)
    expect(pipe.writeEnd.poll?.(pipe.writeFile)! & EPOLLOUT).toBeTruthy()
  })
})
