import { describe, it, expect } from 'vitest'
import { WindowServer } from '#windowserver.ts'
import { WinBoxRenderer } from '#windows.ts'

describe('WinBoxRenderer', () => {
  // WinBox is loaded on demand (it touches `document` at import), so the renderer must be initialised first
  async function newWindows() {
    const windows = new WindowServer()
    const renderer = new WinBoxRenderer()
    await renderer.init()
    windows.registerRenderer(renderer)
    return windows
  }

  it('should create a new window', async () => {
    const windows = await newWindows()
    const win = windows.create()
    expect(win).toBeDefined()
    expect(win.body).toBeInstanceOf(HTMLElement)
  })

  it('should create a new window with a custom id', async () => {
    const windows = await newWindows()
    const win = windows.create({ id: 'test' })
    expect(win.id).toBe('test')
    expect(win.dom.id).toBe('test')
  })

  it('should create a new window with a custom title', async () => {
    const windows = await newWindows()
    const win = windows.create({ title: 'Test' })
    expect(win.info.title).toBe('Test')
    expect(win.dom.querySelector('.wb-title')?.textContent).toBe('Test')
  })

  it('should mount an element into the window', async () => {
    const windows = await newWindows()
    const win = windows.create()
    const child = document.createElement('p')
    win.mount(child)
    expect(win.body.contains(child)).toBe(true)
  })

  it('should close a window', async () => {
    const windows = await newWindows()
    const win = windows.create()
    windows.close(win.id)
    expect(windows.get(win.id)).toBeUndefined()
    expect(document.getElementById(String(win.id))).toBeNull()
  })

  it('should drop a window the user closes', async () => {
    const windows = await newWindows()
    const win = windows.create()
    ;(win.dom.querySelector('.wb-close') as HTMLElement).click()
    expect(windows.get(win.id)).toBeUndefined()
  })

  it('should track minimizing in the server and the body class', async () => {
    const windows = await newWindows()
    const win = windows.create()
    win.setState('minimized')
    expect(win.info.state).toBe('minimized')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(document.body.classList.contains('has-minimized-windows')).toBe(true)
    win.close(true)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(document.body.classList.contains('has-minimized-windows')).toBe(false)
  })

  it('should report a user move back to the server', async () => {
    const windows = await newWindows()
    const win = windows.create({ x: 0, y: 0 })
    ;(win.dom as unknown as { winbox: { move(x: number, y: number): void } }).winbox.move(40, 50)
    expect(win.info.geometry).toMatchObject({ x: 40, y: 50 })
  })
})
