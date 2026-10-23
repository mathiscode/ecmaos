import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@ecmaos/types'

import { exitScreensaver, openScreensaver } from '#lib/screensaver.ts'
import matrix from '#lib/screensavers/matrix.ts'

const fakeTerminal = (listening: boolean) => {
  const terminal = {
    listening,
    listen: vi.fn(() => { terminal.listening = true }),
    unlisten: vi.fn(() => { terminal.listening = false })
  }
  return terminal
}

const fakeContext = () => ({ font: '10px sans-serif', fillStyle: '', fillRect: vi.fn(), fillText: vi.fn() })

describe('screensavers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'performance'] })
    // jsdom has no canvas
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext() as never)
  })

  afterEach(async () => {
    await exitScreensaver()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('leave no listeners behind: a mouse move after many runs gives the terminal back once', async () => {
    const terminal = fakeTerminal(true)
    const added = vi.spyOn(document, 'addEventListener')
    for (let i = 0; i < 20; i++) {
      await matrix({ terminal: terminal as unknown as Terminal })
      document.dispatchEvent(new MouseEvent('mousemove'))
    }
    expect(terminal.listen).toHaveBeenCalledTimes(20)
    terminal.listen.mockClear()
    document.dispatchEvent(new MouseEvent('mousemove'))
    document.dispatchEvent(new KeyboardEvent('keydown'))
    expect(terminal.listen).not.toHaveBeenCalled()
    expect(document.getElementById('screensaver')).toBeNull()
    expect(added).toHaveBeenCalledTimes(60)
    for (const [, , options] of added.mock.calls) expect((options as AddEventListenerOptions | undefined)?.signal?.aborted).toBe(true)
  })

  it('give the terminal back only if it was listening', async () => {
    const terminal = fakeTerminal(false)
    await matrix({ terminal: terminal as unknown as Terminal })
    expect(document.getElementById('screensaver')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown'))
    expect(terminal.listen).not.toHaveBeenCalled()
    expect(document.getElementById('screensaver')).toBeNull()
  })

  it('draw on animation frames and go black after five minutes', async () => {
    const saver = openScreensaver(fakeTerminal(true) as unknown as Terminal)!
    const draw = vi.fn()
    saver.animate(draw)
    vi.advanceTimersByTime(1000)
    // 30 a second, from frames of 16ms
    expect(draw.mock.calls.length).toBeGreaterThanOrEqual(29)
    expect(draw.mock.calls.length).toBeLessThanOrEqual(31)
    vi.advanceTimersByTime(5 * 60_000)
    const drawn = draw.mock.calls.length
    vi.advanceTimersByTime(10_000)
    expect(draw.mock.calls.length).toBe(drawn)
    expect(vi.getTimerCount()).toBe(0)
  })
})
