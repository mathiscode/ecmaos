import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import WebSocket from 'ws'

import type { ToDisplay, ToKernel, WindowGeometry } from '@ecmaos/types'

import { WindowServer } from '../../kernel/src/tree/windowserver.ts'
import { findBrowser } from '../src/display/launch.ts'
import { nodeDisplay } from '../src/display/index.ts'
import type { HostWindow, Launcher } from '../src/display/launch.ts'

/** A launcher that records what it was asked to open instead of starting a browser */
function fakeLauncher() {
  const opened: Array<{ url: string, geometry: WindowGeometry, title: string, killed: boolean, end(): void }> = []
  const launcher: Launcher = {
    launch(url, geometry, title) {
      let end!: () => void
      const exited = new Promise<void>(resolve => { end = resolve })
      const record = { url, geometry, title, killed: false, end }
      opened.push(record)
      return { kill: () => { record.killed = true; end() }, exited } satisfies HostWindow
    }
  }
  return { launcher, opened }
}

/** The page: connects with the token from the URL fragment, collects what the kernel sends */
async function page(url: string, options: { token?: string, origin?: string } = {}) {
  const parsed = new URL(url)
  const socket = new WebSocket(`ws://${parsed.host}/ws`, { headers: { Origin: options.origin ?? parsed.origin } })
  const received: ToDisplay[] = []
  const closed = new Promise<number>(resolve => socket.on('close', code => resolve(code)))
  socket.on('message', data => received.push(JSON.parse(data.toString()) as ToDisplay))
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  const send = (message: ToKernel) => socket.send(JSON.stringify(message))
  send({ t: 'hello', token: options.token ?? parsed.hash.slice(1) })
  return { socket, received, send, closed }
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`timed out waiting for ${what}`)
}

const displays: Array<ReturnType<typeof nodeDisplay>> = []
afterEach(async () => { await Promise.all(displays.splice(0).map(display => display.close())) })

function setup() {
  const { launcher, opened } = fakeLauncher()
  const display = nodeDisplay({ launcher })
  displays.push(display)
  const windows = new WindowServer()
  windows.registerRenderer(display.renderer)
  return { windows, display, opened }
}

describe('host windows', () => {
  it('start nothing until a window is created, then open one host window each', async () => {
    const { windows, opened } = setup()
    expect(opened).toHaveLength(0)
    const first = windows.create({ title: 'One', width: 400, height: 300 })
    const second = windows.create({ title: 'Two' })
    await until(() => opened.length === 2, 'two host windows')
    expect(opened[0]).toMatchObject({ title: 'One', geometry: { width: 400, height: 300 } })
    expect(opened[0]!.url).not.toBe(opened[1]!.url)
    expect(first.id).not.toBe(second.id)
  })

  it('send the window and its content to the page that connects', async () => {
    const { windows, opened } = setup()
    const win = windows.create({ title: 'Hello', html: '<b>hi</b>' })
    await until(() => opened.length === 1, 'a host window')
    const connection = await page(opened[0]!.url)
    await until(() => connection.received.some(m => m.t === 'open'), 'open')
    expect(connection.received[0]).toEqual({ t: 'ready' })
    expect(connection.received[1]).toMatchObject({ t: 'open', id: win.id, title: 'Hello', content: { html: '<b>hi</b>' } })

    win.setTitle('Renamed')
    win.setContent({ text: 'plain' })
    await until(() => connection.received.some(m => m.t === 'content'), 'content')
    expect(connection.received.find(m => m.t === 'update')).toMatchObject({ title: 'Renamed' })
    expect(connection.received.find(m => m.t === 'content')).toMatchObject({ content: { text: 'plain' } })
    connection.socket.close()
  })

  it('apply what the page reports (focus, geometry) to the window server', async () => {
    const { windows, opened } = setup()
    const a = windows.create({ title: 'A' })
    const b = windows.create({ title: 'B' })
    await until(() => opened.length === 2, 'two host windows')
    const connection = await page(opened[0]!.url)
    await until(() => connection.received.some(m => m.t === 'open'), 'open')
    expect(windows.list().at(-1)!.id).toBe(b.id)
    connection.send({ t: 'focused', id: a.id })
    connection.send({ t: 'changed', id: a.id, geometry: { x: 10, y: 20, width: 500, height: 400 } })
    await until(() => windows.get(a.id)!.info.geometry.width === 500, 'geometry')
    expect(windows.get(a.id)!.info).toMatchObject({ focused: true, geometry: { x: 10, y: 20, width: 500, height: 400 } })
    connection.socket.close()
  })

  it('ignore a page that speaks for another window', async () => {
    const { windows, opened } = setup()
    const a = windows.create({ title: 'A' })
    const b = windows.create({ title: 'B' })
    await until(() => opened.length === 2, 'two host windows')
    const connection = await page(opened[0]!.url)
    await until(() => connection.received.some(m => m.t === 'open'), 'open')
    connection.send({ t: 'changed', id: b.id, title: 'hijacked' })
    connection.send({ t: 'changed', id: a.id, title: 'mine' })
    await until(() => windows.get(a.id)!.info.title === 'mine', 'title')
    expect(windows.get(b.id)!.info.title).toBe('B')
    connection.socket.close()
  })

  it('close the ecmaOS window when the host window goes away', async () => {
    const { windows, opened } = setup()
    const win = windows.create({ title: 'Closing' })
    await until(() => opened.length === 1, 'a host window')
    const connection = await page(opened[0]!.url)
    await until(() => connection.received.some(m => m.t === 'open'), 'open')
    connection.socket.close()
    await until(() => windows.get(win.id) === undefined, 'the window closing')
  })

  it('open the host window again when the owner vetoes the close', async () => {
    const { windows, opened } = setup()
    let veto = true
    const win = windows.create({ title: 'Keep', onclose: () => veto })
    await until(() => opened.length === 1, 'a host window')
    const connection = await page(opened[0]!.url)
    await until(() => connection.received.some(m => m.t === 'open'), 'open')
    connection.socket.close()
    await until(() => opened.length === 2, 'a second host window')
    expect(windows.get(win.id)).toBeDefined()
    veto = false
    windows.close(win.id)
    expect(windows.get(win.id)).toBeUndefined()
  })

  it('tell the page to close when the window is closed', async () => {
    const { windows, opened } = setup()
    const win = windows.create({ title: 'Bye' })
    await until(() => opened.length === 1, 'a host window')
    const connection = await page(opened[0]!.url)
    await until(() => connection.received.some(m => m.t === 'open'), 'open')
    windows.close(win.id, true)
    await until(() => connection.received.some(m => m.t === 'close'), 'close')
    expect(await connection.closed).toBe(1000)
  })

  it('refuse a page with a wrong token, a spent token, or a foreign origin', async () => {
    const { windows, opened } = setup()
    windows.create({ title: 'Guarded' })
    await until(() => opened.length === 1, 'a host window')
    const url = opened[0]!.url

    const wrong = await page(url, { token: 'nope' })
    expect(await wrong.closed).toBe(1008)

    const good = await page(url)
    await until(() => good.received.some(m => m.t === 'open'), 'open')
    const replay = await page(url)
    expect(await replay.closed).toBe(1008)

    const foreign = new WebSocket(`ws://${new URL(url).host}/ws`, { headers: { Origin: 'http://evil.example' } })
    const error = await new Promise<Error>(resolve => foreign.once('error', resolve))
    expect(error.message).toMatch(/socket hang up|Unexpected server response|ECONNRESET/)
    good.socket.close()
  })

  it('serve the page only to the loopback name, and without the token in a request line', async () => {
    const { windows, opened } = setup()
    windows.create({ title: 'Page' })
    await until(() => opened.length === 1, 'a host window')
    const origin = new URL(opened[0]!.url)
    const get = (host: string) => new Promise<{ status: number, body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: origin.port, path: '/', headers: { Host: host } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end()
    })
    const ok = await get(origin.host)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('WebSocket')
    expect((await get(`rebind.example:${origin.port}`)).status).toBe(421)
  })

  it('fail clearly when the host has no display, without starting anything', () => {
    const display = nodeDisplay({ launcher: { unavailable: 'this host has no display', launch() { throw new Error('unreachable') } } })
    displays.push(display)
    const windows = new WindowServer()
    windows.registerRenderer(display.renderer)
    expect(() => windows.create({ title: 'Nope' })).toThrow(/Windows are unavailable: this host has no display/)
    expect(display.unavailable).toBe('this host has no display')
  })
})

describe('finding a browser', () => {
  it('reports why windows cannot open', () => {
    expect(findBrowser({ ECMAOS_DISPLAY: '0' }, 'linux')).toEqual({ unavailable: 'host windows are turned off (ECMAOS_DISPLAY)' })
    expect(findBrowser({ PATH: '/nowhere' }, 'linux')).toMatchObject({ unavailable: expect.stringContaining('no display') })
    expect(findBrowser({ DISPLAY: ':0', PATH: '/nowhere' }, 'linux')).toMatchObject({ unavailable: expect.stringContaining('no Chromium-based browser') })
    expect(findBrowser({ DISPLAY: ':0', ECMAOS_BROWSER: '/nope/chrome' }, 'linux')).toMatchObject({ unavailable: expect.stringContaining('does not exist') })
  })

  it('takes the browser named by ECMAOS_BROWSER', () => {
    expect(findBrowser({ DISPLAY: ':0', ECMAOS_BROWSER: process.execPath }, 'linux')).toEqual({ path: process.execPath })
  })
})
