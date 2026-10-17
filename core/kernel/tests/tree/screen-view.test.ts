import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToKernel } from '@ecmaos/types'

import { WindowServer } from '#windowserver.ts'
import { WinBoxRenderer } from '#windows.ts'
import { ScreenView } from '#lib/screen-view.ts'

const geometry = { x: 0, y: 0, width: 400, height: 300 }

async function setup() {
  const windows = new WindowServer()
  const renderer = new WinBoxRenderer()
  await renderer.init()
  windows.registerRenderer(renderer)
  const sent: ToKernel[] = []
  const view = new ScreenView(message => { sent.push(message) }, windows)
  return { windows, view, sent }
}

const open = (id: string, extra: Record<string, unknown> = {}) => ({ t: 'open', id, title: `Window ${id}`, geometry, state: 'normal', frameless: false, modal: false, ...extra }) as never

afterEach(() => { window.onbeforeunload = null })

describe('ScreenView', () => {
  it('draws the machine\'s windows, cascading the ones it did not place', async () => {
    const { windows, view } = await setup()
    view.handle(open('a', { content: { text: 'hello' } }))
    view.handle(open('b'))
    expect(windows.list().map(info => info.title)).toEqual(['Window a', 'Window b'])
    const [a, b] = windows.list()
    expect(b!.geometry.x).toBeGreaterThan(a!.geometry.x)
    expect(windows.get('a')!.body.textContent).toBe('hello')
    view.dispose()
  })

  it('applies updates and new content from the machine without sending them back', async () => {
    const { windows, view, sent } = await setup()
    view.handle(open('a'))
    view.handle({ t: 'update', id: 'a', title: 'Renamed', geometry: { x: 50, y: 60, width: 500, height: 350 }, state: 'normal' })
    expect(windows.get('a')!.info).toMatchObject({ title: 'Renamed', geometry: { x: 50, y: 60, width: 500, height: 350 } })
    view.handle({ t: 'content', id: 'a', content: { html: '<b>hi</b>' } })
    const frame = windows.get('a')!.body.querySelector('iframe')!
    expect(frame.srcdoc).toBe('<b>hi</b>')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(sent).toEqual([])
    view.dispose()
  })

  it('asks the machine to close when the user closes a window, and closes it when told', async () => {
    const { windows, view, sent } = await setup()
    view.handle(open('a'))
    ;(windows.get('a')!.dom.querySelector('.wb-close') as HTMLElement).click()
    expect(sent).toEqual([{ t: 'close-request', id: 'a' }])
    expect(windows.get('a')).toBeDefined()
    view.handle({ t: 'close', id: 'a' })
    expect(windows.get('a')).toBeUndefined()
    expect(view.count).toBe(0)
    // closing for the machine is not a request back to it
    expect(sent).toHaveLength(1)
  })

  it('reports what the user does to a window', async () => {
    const { windows, view, sent } = await setup()
    view.handle(open('a'))
    view.handle(open('b'))
    sent.length = 0
    ;(windows.get('a')!.dom as unknown as { winbox: { move(x: number, y: number): void } }).winbox.move(120, 130)
    await Promise.resolve()
    expect(sent).toContainEqual(expect.objectContaining({ t: 'changed', id: 'a', geometry: expect.objectContaining({ x: 120, y: 130 }) }))
    sent.length = 0
    windows.focus('a')
    expect(sent).toContainEqual({ t: 'focused', id: 'a' })
    view.dispose()
  })

  it('runs an app in a sandboxed frame and carries its calls and answers', async () => {
    const { windows, view, sent } = await setup()
    view.handle(open('a', { content: { app: { source: 'export const display = () => {}', command: 'x', args: [], cwd: '/', env: {}, pid: 1, uid: 0, gid: 0 } } }))
    const frame = windows.get('a')!.body.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.srcdoc).toContain('postMessage')

    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' }, source: frame.contentWindow }))
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'boot', launch: expect.objectContaining({ command: 'x' }) }), '*')

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'call', n: 7, op: 'fs.readFile', args: ['/a'] }, source: frame.contentWindow }))
    expect(sent).toContainEqual({ t: 'call', id: 'a', call: 7, op: 'fs.readFile', args: ['/a'] })
    view.handle({ t: 'result', id: 'a', call: 7, result: { $bytes: 'AQ==' } })
    expect(post).toHaveBeenCalledWith({ type: 'result', n: 7, result: { $bytes: 'AQ==' }, error: undefined }, '*')

    // a message that does not come from the app's frame is ignored
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'call', n: 8, op: 'x', args: [] }, source: window }))
    expect(sent.filter(message => message.t === 'call')).toHaveLength(1)
    view.dispose()
    expect(windows.get('a')).toBeUndefined()
  })

  it('asks before the page is left while an app has unsaved changes', async () => {
    const { windows, view } = await setup()
    view.handle(open('a', { content: { app: { source: '', command: 'x', args: [], cwd: '/', env: {}, pid: 1, uid: 0, gid: 0 } } }))
    const frame = windows.get('a')!.body.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dirty', value: true }, source: frame.contentWindow }))
    expect(view.dirty).toBe(true)
    expect(window.onbeforeunload).toBeTypeOf('function')
    view.handle({ t: 'close', id: 'a' })
    expect(view.dirty).toBe(false)
    expect(window.onbeforeunload).toBeNull()
  })
})
