import { beforeAll, describe, it, expect } from 'vitest'
import { Windows } from '#windows.ts'

describe('Windows', () => {
  // WinBox is loaded on demand (it touches `document` at import), so a Windows must be initialised first
  async function newWindows() {
    const windows = new Windows()
    await windows.init()
    return windows
  }

  beforeAll(async () => { await newWindows() })

  it('should create a new window', async () => {
    const windows = await newWindows()
    const win = windows.create()
    expect(win).toBeDefined()
  })

  it('should create a new window with a custom id', async () => {
    const windows = await newWindows()
    const win = windows.create({ id: 'test' })
    expect(win).toBeDefined()
    expect(win.id).toBe('test')
  })

  it('should create a new window with a custom title', async () => {
    const windows = await newWindows()
    const win = windows.create({ title: 'Test' })
    expect(win).toBeDefined()
    expect(win.title).toBe('Test')
  })

  it('should close a window', async () => {
    const windows = await newWindows()
    const win = windows.create()
    expect(win).toBeDefined()
    windows.close(win.id)
    expect(windows.get(win.id)).toBeUndefined()
  })
})
