import { describe, expect, it, vi } from 'vitest'
import type { WindowId, WindowInfo, WindowInsets, WindowKind, WindowOptions, WindowRenderer, WindowReports } from '@ecmaos/types'

import { WindowServer } from '#windowserver.ts'

/** Records what the server asks of a renderer, and lets a test play the user. */
class FakeRenderer implements WindowRenderer {
  reports!: WindowReports
  created: WindowId[] = []
  closed: WindowId[] = []
  updates: WindowInfo[] = []
  areas: WindowInsets[] = []
  constructor(private kinds: WindowKind[] = ['web']) {}
  supports(kind: WindowKind) { return this.kinds.includes(kind) }
  attach(reports: WindowReports) { this.reports = reports }
  create(info: WindowInfo, _options: WindowOptions) { this.created.push(info.id) }
  update(info: WindowInfo) { this.updates.push({ ...info }) }
  close(id: WindowId) { this.closed.push(id) }
  workareaChanged(insets: WindowInsets) { this.areas.push(insets) }
}

const owner = (pid: number, uid = 1000) => ({ pid, uid, gid: uid })

const setup = () => {
  const server = new WindowServer()
  const renderer = new FakeRenderer()
  server.registerRenderer(renderer)
  return { server, renderer }
}

describe('WindowServer', () => {
  it('fails with ENODEV when no renderer supports the kind', () => {
    expect(() => new WindowServer().create({ title: 'x' })).toThrow(expect.objectContaining({ errno: expect.any(Number), message: expect.stringContaining('unavailable') }))
  })

  it('creates windows with defaults and reports them in the list', () => {
    const { server, renderer } = setup()
    const win = server.create({ id: 'a', title: 'A', width: 400, height: 250 })
    expect(renderer.created).toEqual(['a'])
    expect(win.info).toMatchObject({ id: 'a', title: 'A', kind: 'web', state: 'normal', focused: true, owner: { pid: 0 }, geometry: { width: 400, height: 250 } })
    expect(server.list().map(info => info.id)).toEqual(['a'])
    expect(server.get('a')?.id).toBe('a')
  })

  it('starts maximized with max, and sizes dialogs as modal', () => {
    const { server } = setup()
    expect(server.create({ max: true }).info.state).toBe('maximized')
    const dialog = server.dialog({ title: 'd' })
    expect(dialog.info).toMatchObject({ modal: true, geometry: { width: 320, height: 200 } })
  })

  it('rejects a duplicate id', () => {
    const { server } = setup()
    server.create({ id: 'a' })
    expect(() => server.create({ id: 'a' })).toThrow(/already exists/)
  })

  it('keeps focus order, and closing the top window focuses the one below', () => {
    const { server } = setup()
    server.create({ id: 'a' })
    server.create({ id: 'b' })
    server.create({ id: 'c' })
    expect(server.list().map(info => info.id)).toEqual(['a', 'b', 'c'])
    server.focus('a')
    expect(server.list().map(info => info.id)).toEqual(['b', 'c', 'a'])
    expect(server.list().filter(info => info.focused).map(info => info.id)).toEqual(['a'])
    server.close('a')
    expect(server.list().find(info => info.focused)?.id).toBe('c')
  })

  it('restores a minimized window when it is focused', () => {
    const { server } = setup()
    const win = server.create({ id: 'a' })
    win.setState('minimized')
    expect(win.info.state).toBe('minimized')
    win.focus()
    expect(win.info.state).toBe('normal')
  })

  it('records where the renderer put a new window, so a centred one keeps its place when resized', () => {
    const { server, renderer } = setup()
    renderer.create = (info: WindowInfo) => ({ geometry: { ...info.geometry, x: 300, y: 200 } })
    const win = server.create({ id: 'a', x: 'center', y: 'center', width: 400, height: 250 })
    expect(win.info.geometry).toEqual({ x: 300, y: 200, width: 400, height: 250 })
    win.resize(420, 280)
    expect(renderer.updates.at(-1)?.geometry).toEqual({ x: 300, y: 200, width: 420, height: 280 })
  })

  it('updates title and geometry and tells the renderer', () => {
    const { server, renderer } = setup()
    const win = server.create({ id: 'a' })
    win.setTitle('new')
    win.move(10, 20)
    win.resize(500, 400)
    expect(win.info).toMatchObject({ title: 'new', geometry: { x: 10, y: 20, width: 500, height: 400 } })
    expect(renderer.updates.length).toBe(3)
  })

  it('emits create, update, focus and close', () => {
    const { server } = setup()
    const seen: string[] = []
    for (const event of ['create', 'update', 'focus', 'close'] as const) server.on(event, info => seen.push(`${event}:${info.id}`))
    const win = server.create({ id: 'a' })
    win.setTitle('t')
    win.close()
    expect(seen).toEqual(['create:a', 'focus:a', 'update:a', 'close:a'])
  })

  it('stops delivering events after unsubscribe', () => {
    const { server } = setup()
    const listener = vi.fn()
    server.on('create', listener)()
    server.create({})
    expect(listener).not.toHaveBeenCalled()
  })

  it('lets onclose keep a window open unless forced', () => {
    const { server, renderer } = setup()
    const win = server.create({ id: 'a', onclose: () => true })
    expect(server.close('a')).toBe(false)
    expect(server.get('a')).toBeDefined()
    expect(renderer.closed).toEqual([])
    expect(server.close('a', true)).toBe(true)
    expect(server.get('a')).toBeUndefined()
    expect(renderer.closed).toEqual(['a'])
    expect(win.info.id).toBe('a')
  })

  it('closes on a renderer request without calling the renderer back', () => {
    const { server, renderer } = setup()
    server.create({ id: 'a', onclose: () => false })
    server.create({ id: 'b', onclose: () => true })
    expect(renderer.reports.closeRequested('a')).toBe(true)
    expect(renderer.reports.closeRequested('b')).toBe(false)
    expect(server.list().map(info => info.id)).toEqual(['b'])
    expect(renderer.closed).toEqual([])
  })

  it('takes changes the user makes from the renderer', () => {
    const { server, renderer } = setup()
    server.create({ id: 'a' })
    renderer.reports.changed('a', { state: 'maximized', geometry: { x: 1, y: 2, width: 3, height: 4 } })
    expect(server.get('a')?.info).toMatchObject({ state: 'maximized', geometry: { x: 1, y: 2, width: 3, height: 4 } })
    server.create({ id: 'b' })
    renderer.reports.focused('a')
    expect(server.list().find(info => info.focused)?.id).toBe('a')
  })

  it('closes a process\'s windows when it exits, and only those', () => {
    const { server } = setup()
    server.create({ id: 'a', owner: owner(10) })
    server.create({ id: 'b', owner: owner(10), onclose: () => true })
    server.create({ id: 'c', owner: owner(11) })
    server.create({ id: 'd' })
    server.closeOwnedBy(10)
    expect(server.list().map(info => info.id).sort()).toEqual(['c', 'd'])
  })

  it('filters the list by pid and uid', () => {
    const { server } = setup()
    server.create({ id: 'a', owner: owner(10, 1000) })
    server.create({ id: 'b', owner: owner(11, 1001) })
    expect(server.list({ pid: 10 }).map(info => info.id)).toEqual(['a'])
    expect(server.list({ uid: 1001 }).map(info => info.id)).toEqual(['b'])
  })

  it('limits windows per process but not the kernel', () => {
    const { server } = setup()
    server.maxPerProcess = 2
    server.create({ owner: owner(10) })
    server.create({ owner: owner(10) })
    expect(() => server.create({ owner: owner(10) })).toThrow(/Too many windows/)
    server.create({ owner: owner(11) })
    for (let i = 0; i < 5; i++) server.create({})
    expect(server.list().length).toBe(8)
  })

  it('uses the newest renderer that supports the kind', () => {
    const server = new WindowServer()
    const first = new FakeRenderer()
    const second = new FakeRenderer()
    server.registerRenderer(first)
    server.registerRenderer(second)
    server.create({ id: 'a' })
    expect(first.created).toEqual([])
    expect(second.created).toEqual(['a'])
  })

  it('has no DOM content for a renderer that draws none', () => {
    const { server } = setup()
    const win = server.create({})
    expect(() => win.body).toThrow(/does not draw with the DOM/)
    expect(() => win.mount({} as HTMLElement)).toThrow(/no body/)
  })

  it('hands out the content element a DOM renderer drew', () => {
    const server = new WindowServer()
    const body = { replaceChildren: vi.fn() } as unknown as HTMLElement
    const dom = {} as HTMLElement
    server.registerRenderer({ ...new FakeRenderer(), supports: () => true, attach: () => {}, create: () => ({ body, dom }), update: () => {}, close: () => {} })
    const win = server.create({})
    expect(win.body).toBe(body)
    expect(win.dom).toBe(dom)
    const child = {} as HTMLElement
    win.mount(child)
    expect(body.replaceChildren).toHaveBeenCalledWith(child)
  })

  it('reserves a work area for renderers and listeners, ignoring repeats and negatives', () => {
    const { server, renderer } = setup()
    const seen: WindowInsets[] = []
    server.onWorkarea(insets => seen.push(insets))
    expect(server.workarea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    server.setWorkarea({ bottom: 40.4 })
    server.setWorkarea({ bottom: 40 })
    server.setWorkarea({ top: -5 })
    expect(server.workarea).toEqual({ top: 0, right: 0, bottom: 40, left: 0 })
    expect(renderer.areas).toEqual([{ top: 0, right: 0, bottom: 40, left: 0 }])
    expect(seen).toEqual(renderer.areas)
    expect(renderer.reports.workarea()).toEqual({ top: 0, right: 0, bottom: 40, left: 0 })
  })

  it('starts with minimized windows docked and tells renderers when the mode changes', () => {
    const { server, renderer } = setup()
    const modes: string[] = []
    renderer.minimizeModeChanged = mode => { modes.push(mode) }
    expect(server.minimizeMode).toBe('dock')
    server.setMinimizeMode('hidden')
    server.setMinimizeMode('hidden')
    expect(renderer.reports.minimizeMode()).toBe('hidden')
    server.setMinimizeMode('dock')
    expect(modes).toEqual(['hidden', 'dock'])
  })

  it('focusing a minimized window returns it to the state it had before', () => {
    const { server } = setup()
    const win = server.create({})
    win.setState('maximized')
    win.setState('minimized')
    const updates: string[] = []
    server.on('update', info => { updates.push(info.state) })
    win.focus()
    expect(updates).toEqual(['maximized'])
    expect(win.info.state).toBe('maximized')
    win.setState('minimized')
    server.update(win.id, { state: 'normal' })
    win.setState('minimized')
    win.focus()
    expect(win.info.state).toBe('normal')
  })
})

describe('WindowServer content', () => {
  it('fails with ENODEV when the renderer draws with the DOM', () => {
    const windows = new WindowServer()
    windows.registerRenderer({ supports: () => true, attach() {}, create() {}, update() {}, close() {} })
    const win = windows.create()
    expect(() => win.setContent({ text: 'x' })).toThrow(/cannot show content/)
  })

  it('hands content to a renderer that takes it', () => {
    const windows = new WindowServer()
    const seen: unknown[] = []
    windows.registerRenderer({ supports: () => true, attach() {}, create() {}, update() {}, close() {}, content: (id, content) => { seen.push([id, content]) } })
    const win = windows.create({ id: 'w' })
    win.setContent({ html: '<p>hi</p>' })
    expect(seen).toEqual([['w', { html: '<p>hi</p>' }]])
  })
})

describe('WindowServer calls', () => {
  it('routes a renderer-reported call to the window\'s handler, and refuses when there is none', async () => {
    const windows = new WindowServer()
    let reports!: WindowReports
    windows.registerRenderer({ supports: () => true, attach: r => { reports = r }, create() {}, update() {}, close() {} })
    const win = windows.create({ id: 'w' })
    await expect(reports.call('w', 'x', [])).rejects.toThrow(/answers calls/)
    win.onCall((op, args) => [op, args])
    await expect(reports.call('w', 'x', [1])).resolves.toEqual(['x', [1]])
    win.onCall(undefined)
    await expect(reports.call('w', 'x', [])).rejects.toThrow(/answers calls/)
  })
})

describe('WindowServer workspaces', () => {
  it('opens windows on the current workspace and hides the ones on the others when it switches', () => {
    const { server, renderer } = setup()
    expect(server.workspaces).toBe(1)
    server.setWorkspaceCount(4)
    const a = server.create({ id: 'a' })
    server.switchWorkspace(1)
    const b = server.create({ id: 'b' })
    expect([a.info.workspace, a.info.hidden, b.info.workspace, b.info.hidden]).toEqual([0, true, 1, false])
    expect(renderer.updates.some(info => info.id === 'a' && info.hidden)).toBe(true)
    expect(b.info.focused).toBe(true)

    server.switchWorkspace(0)
    expect([a.info.hidden, b.info.hidden, a.info.focused, b.info.focused]).toEqual([false, true, true, false])
  })

  it('moves a window to a workspace, hiding it and handing focus to the one below', () => {
    const { server } = setup()
    server.setWorkspaceCount(4)
    const a = server.create({ id: 'a' })
    const b = server.create({ id: 'b' })
    server.moveToWorkspace('b', 2)
    expect([b.info.workspace, b.info.hidden, b.info.focused, a.info.focused]).toEqual([2, true, false, true])
    expect(() => server.moveToWorkspace('b', 9)).toThrow()
  })

  it('switches to the workspace of a window that is focused', () => {
    const { server } = setup()
    server.setWorkspaceCount(4)
    const a = server.create({ id: 'a' })
    server.switchWorkspace(3)
    expect(a.info.hidden).toBe(true)
    a.focus()
    expect(server.workspace).toBe(0)
    expect([a.info.hidden, a.info.focused]).toEqual([false, true])
  })

  it('keeps a window that closes from handing focus to a hidden one', () => {
    const { server } = setup()
    server.setWorkspaceCount(4)
    const a = server.create({ id: 'a' })
    server.switchWorkspace(1)
    const b = server.create({ id: 'b' })
    b.close(true)
    expect(a.info.focused).toBe(false)
  })

  it('reports a change to a listener, and moves windows off a removed workspace to the last one', () => {
    const { server } = setup()
    server.setWorkspaceCount(4)
    const seen: Array<[number, number]> = []
    server.onWorkspace((workspace, count) => seen.push([workspace, count]))
    server.switchWorkspace(3)
    const d = server.create({ id: 'd' })
    server.setWorkspaceCount(2)
    expect([server.workspace, d.info.workspace]).toEqual([1, 1])
    expect(seen).toEqual([[3, 4], [1, 2]])
    expect(() => server.switchWorkspace(2)).toThrow()
    server.setWorkspaceCount(99)
    expect(server.workspaces).toBe(16)
  })
})
