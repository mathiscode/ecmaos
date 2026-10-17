import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WindowInfo, WindowRenderer, WindowReports } from '@ecmaos/types'

import { PopupRenderer } from '#popups.ts'

const info = (id: string, overrides: Partial<WindowInfo> = {}): WindowInfo => ({
  id, title: 'T', kind: 'web', owner: { pid: 1, uid: 0, gid: 0 }, state: 'normal',
  geometry: { x: 10, y: 20, width: 300, height: 200 }, focused: false, modal: false, frameless: false, created: 0, ...overrides
})

function fakePopup() {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const popup = iframe.contentWindow as Window & { closed: boolean }
  let closed = false
  Object.defineProperty(popup, 'closed', { get: () => closed })
  popup.close = () => { closed = true; popup.dispatchEvent(new Event('pagehide')) }
  popup.moveTo = vi.fn()
  popup.resizeTo = vi.fn()
  return { popup, userClose: () => popup.close() }
}

function setup(open: () => Window | null, enabled = true) {
  const fallbackBody = document.createElement('div')
  const fallback = {
    supports: () => true, attach: vi.fn(), create: vi.fn(() => ({ body: fallbackBody, dom: fallbackBody })),
    update: vi.fn(), close: vi.fn()
  } satisfies WindowRenderer
  const reports = { closeRequested: vi.fn(() => true), changed: vi.fn(), focused: vi.fn() } as unknown as WindowReports
  const renderer = new PopupRenderer(fallback, { enabled: () => enabled, open })
  renderer.attach(reports)
  return { renderer, fallback, reports, fallbackBody }
}

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

describe('PopupRenderer', () => {
  it('is off unless enabled, and needs a renderer to fall back on', () => {
    expect(setup(() => null, false).renderer.supports('web')).toBe(false)
    expect(setup(() => null).renderer.supports('web')).toBe(true)
  })

  it('opens a popup at the window place and hands out an element of its document', () => {
    const { popup } = fakePopup()
    const open = vi.fn(() => popup)
    const { renderer } = setup(open)
    const drawn = renderer.create(info('a', { title: 'Hello' }), { html: '<b>hi</b>' })!
    expect(open).toHaveBeenCalledWith('', 'ecmaos-a', 'popup=yes,left=10,top=20,width=300,height=200')
    expect(drawn.body!.ownerDocument).toBe(popup.document)
    expect(drawn.body!.innerHTML).toBe('<b>hi</b>')
    expect(popup.document.title).toBe('Hello')
  })

  it('draws the window with the fallback when the browser refuses the popup, and routes later calls there', () => {
    const { renderer, fallback, fallbackBody } = setup(() => null)
    expect(renderer.create(info('a'), {})!.body).toBe(fallbackBody)
    renderer.update(info('a', { title: 'x' }))
    renderer.close('a')
    expect(fallback.update).toHaveBeenCalledOnce()
    expect(fallback.close).toHaveBeenCalledWith('a')
  })

  it('applies title and geometry and closes the popup when the machine does', () => {
    const { popup } = fakePopup()
    const { renderer, reports } = setup(() => popup)
    renderer.create(info('a'), {})
    renderer.update(info('a', { title: 'New', geometry: { x: 1, y: 2, width: 500, height: 400 } }))
    expect(popup.document.title).toBe('New')
    expect(popup.resizeTo).toHaveBeenCalledWith(500, 400)
    expect(popup.moveTo).toHaveBeenCalledWith(1, 2)
    renderer.close('a')
    expect(popup.closed).toBe(true)
    // the machine's own close is not the user's
    expect(reports.closeRequested).not.toHaveBeenCalled()
  })

  it('asks the machine to close when the user closes the popup', () => {
    const { popup, userClose } = fakePopup()
    const { renderer, reports, fallback } = setup(() => popup)
    renderer.create(info('a'), {})
    userClose()
    expect(reports.closeRequested).toHaveBeenCalledWith('a')
    expect(fallback.create).not.toHaveBeenCalled()
  })

  it('moves the window into the page when the user closes the popup and the machine refuses', () => {
    const { popup, userClose } = fakePopup()
    const { renderer, reports, fallback, fallbackBody } = setup(() => popup)
    vi.mocked(reports.closeRequested).mockReturnValue(false)
    const drawn = renderer.create(info('a'), { html: '<i>kept</i>' })!
    userClose()
    expect(fallback.create).toHaveBeenCalledOnce()
    expect(fallbackBody.contains(drawn.body!)).toBe(true)
    renderer.update(info('a'))
    expect(fallback.update).toHaveBeenCalledOnce()
  })

  it('reports a move or resize the user made', () => {
    vi.useFakeTimers()
    const { popup } = fakePopup()
    const { renderer, reports } = setup(() => popup)
    renderer.create(info('a'), {})
    Object.defineProperty(popup, 'outerWidth', { value: 640, configurable: true })
    Object.defineProperty(popup, 'outerHeight', { value: 480, configurable: true })
    Object.defineProperty(popup, 'screenX', { value: 5, configurable: true })
    Object.defineProperty(popup, 'screenY', { value: 6, configurable: true })
    vi.advanceTimersByTime(500)
    expect(reports.changed).toHaveBeenCalledWith('a', { geometry: { x: 5, y: 6, width: 640, height: 480 } })
    reports.changed = vi.fn()
    vi.advanceTimersByTime(1000)
    expect(reports.changed).not.toHaveBeenCalled()
  })
})
