import { describe, expect, it } from 'vitest'

import { createPipe } from '#lib/pipe.ts'
import { pollAll } from '#lib/poll.ts'
import { EPOLLIN, EPOLLOUT } from '@zenfs/linux'

describe('pollAll', () => {
  it('returns immediately when a target is already ready', async () => {
    const pipe = createPipe()
    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('x'), 0)

    const results = await pollAll([
      { file: pipe.readFile, ops: pipe.readEnd, events: EPOLLIN }
    ])

    expect(results).toHaveLength(1)
    expect(results[0]?.revents & EPOLLIN).toBeTruthy()
  })

  it('polls once and returns empty on a zero timeout when nothing is ready', async () => {
    const pipe = createPipe()
    const results = await pollAll([
      { file: pipe.readFile, ops: pipe.readEnd, events: EPOLLIN }
    ], 0)

    expect(results).toHaveLength(0)
  })

  it('waits until a target becomes ready', async () => {
    const pipe = createPipe()
    const promise = pollAll([
      { file: pipe.readFile, ops: pipe.readEnd, events: EPOLLIN }
    ])

    let settled = false
    promise.then(() => { settled = true })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    pipe.writeEnd.write?.(pipe.writeFile, new TextEncoder().encode('go'), 0)
    const results = await promise
    expect(settled).toBe(true)
    expect(results[0]?.revents & EPOLLIN).toBeTruthy()
  })

  it('resolves with an empty result once the timeout elapses with nothing ready', async () => {
    const pipe = createPipe()
    const results = await pollAll([
      { file: pipe.readFile, ops: pipe.readEnd, events: EPOLLIN }
    ], 15)

    expect(results).toHaveLength(0)
  })

  it('returns only the targets that are ready, not every target polled', async () => {
    const readable = createPipe()
    const idle = createPipe()
    readable.writeEnd.write?.(readable.writeFile, new TextEncoder().encode('x'), 0)

    const results = await pollAll([
      { file: readable.readFile, ops: readable.readEnd, events: EPOLLIN },
      { file: idle.readFile, ops: idle.readEnd, events: EPOLLIN }
    ])

    expect(results).toHaveLength(1)
    expect(results[0]?.target.file).toBe(readable.readFile)
  })

  it('wakes on the first of several targets to become ready', async () => {
    const a = createPipe()
    const b = createPipe()

    const promise = pollAll([
      { file: a.readFile, ops: a.readEnd, events: EPOLLIN },
      { file: b.readFile, ops: b.readEnd, events: EPOLLIN }
    ])

    b.writeEnd.write?.(b.writeFile, new TextEncoder().encode('y'), 0)
    const results = await promise

    expect(results).toHaveLength(1)
    expect(results[0]?.target.file).toBe(b.readFile)
  })

  it('polls for EPOLLOUT independently of EPOLLIN readiness', async () => {
    const pipe = createPipe()
    const results = await pollAll([
      { file: pipe.writeFile, ops: pipe.writeEnd, events: EPOLLOUT }
    ], 0)

    expect(results).toHaveLength(1)
  })

  it('stops waiting on every queue once one target wins, leaving no dangling waiters', async () => {
    const a = createPipe()
    const b = createPipe()

    const promise = pollAll([
      { file: a.readFile, ops: a.readEnd, events: EPOLLIN },
      { file: b.readFile, ops: b.readEnd, events: EPOLLIN }
    ])

    a.writeEnd.write?.(a.writeFile, new TextEncoder().encode('z'), 0)
    await promise

    const aQueue = a.readEnd.poll_wait?.(a.readFile)
    const bQueue = b.readEnd.poll_wait?.(b.readFile)
    expect(aQueue?.waiting).toBe(0)
    expect(bQueue?.waiting).toBe(0)
  })
})
