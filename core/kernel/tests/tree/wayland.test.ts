import { beforeAll, describe, expect, it } from 'vitest'
import { Class } from '@zenfs/linux'
import { sessionOperations } from '@ecmaos-devices/session'

import { DefaultDevices } from '#device.ts'
import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { glContextAt, setGlSurfaceFactory } from '#lib/gl.ts'

import { fakeGlSurfaces } from './fixtures/fake-gl'
import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const doomWad = process.env.DOOM_WAD

const until = async (check: () => boolean | Promise<boolean>, ms = 20000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** wlcomp, the Wayland compositor, with a hand-written client (`fixtures/wl-shm.c`) on the other end of a unix socket. */
describe('the Wayland compositor', () => {
  let kernel: Kernel
  const played: Uint8Array[] = []   // what programs play to /dev/dsp1
  const env = 'XDG_RUNTIME_DIR=/run/user/0 WAYLAND_DISPLAY=wayland-0'
  const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf8').catch(() => '')

  beforeAll(async () => {
    const speakers = {
      pkg: { name: 'audio', version: '0', description: 'a speaker that keeps what it is given' },
      getDrivers: async () => [{
        name: 'dsp1', major: 14, minor: 19, class: new Class('audio'),
        ops: sessionOperations({ open: async () => ({ info: { kind: 'audio-out', read: false, write: true }, write: async (data: Uint8Array) => { played.push(data) }, close: async () => {} }) })
      }]
    }
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, devices: { ...DefaultDevices, audio: speakers as never } })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const root = process.cwd()
    const load = (file: string) => new Uint8Array(readFileSync(file))
    await kernel.filesystem.fs.writeFile('/bin/wlcomp', load(`${root}/../utils/programs/wlcomp.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/wl-shm', load(`${root}/tests/tree/wasi/fixtures/wl-shm.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/wldemo', load(`${root}/../utils/programs/wldemo.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/wl-lib', load(`${root}/tests/tree/wasi/fixtures/wl-lib.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdlsnake', load(`${root}/../utils/programs/sdlsnake.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdlpaint', load(`${root}/../utils/programs/sdlpaint.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdlclip', load(`${root}/../utils/programs/sdlclip.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdlpad', load(`${root}/../utils/programs/sdlpad.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdlgl', load(`${root}/../utils/programs/sdlgl.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdlgears', load(`${root}/../utils/programs/sdlgears.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/doom', load(`${root}/../utils/programs/doom.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdl-clip', load(`${root}/tests/tree/wasi/fixtures/sdl-clip.wasm`), { mode: 0o755 })
    await kernel.filesystem.fs.writeFile('/bin/sdl-win', load(`${root}/tests/tree/wasi/fixtures/sdl-win.wasm`), { mode: 0o755 })
    void kernel.shell.execute(`${env} wlcomp > /tmp/wlcomp.out 2>&1`)
    await until(async () => (await read('/tmp/wlcomp.out')).includes('listening'))
  }, 60_000)

  it('shows what a client commits, in a window the size of the buffer', async () => {
    const client = kernel.shell.execute(`${env} wl-shm 3 40 20 8000 > /tmp/wl-shm.out 2>&1`)
    await until(async () => (await read('/tmp/wl-shm.out')).includes('done'))
    const out = await read('/tmp/wl-shm.out')
    expect(out).toContain('global 1 wl_compositor')
    expect(out).toContain('global 3 xdg_wm_base')
    expect(out).toContain('configured')
    expect(out).toContain('frame 0')
    expect(out).toContain('frame 2')

    const windows = kernel.framebuffers.list()
    expect(windows).toHaveLength(1)
    const fb = windows[0]!
    expect([fb.width, fb.height]).toEqual([40, 20])
    const pixel = (x: number, y: number) => [...fb.pixels.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)]
    // blue first: the client wrote red from x, green from y, blue 120 (the third frame)
    expect(pixel(0, 0)).toEqual([120, 0, 0])
    expect(pixel(39, 19)).toEqual([120, Math.floor(19 * 255 / 20), Math.floor(39 * 255 / 40)])

    // what the user does in the window reaches the client as pointer and keyboard events
    const id = kernel.windows.list().find(w => w.title === 'wl-shm')!.id
    expect(out).toContain('keyboard keymap format=1')
    for (const input of [
      { k: 'pointer', x: 12, y: 7 }, { k: 'enter' }, { k: 'pointer', x: 13, y: 8 }, { k: 'button', button: 0, down: true }, { k: 'button', button: 0, down: false },
      { k: 'wheel', dx: 0, dy: 1 }, { k: 'focus' }, { k: 'key', code: 'ShiftLeft', down: true }, { k: 'key', code: 'KeyA', down: true }, { k: 'key', code: 'KeyA', down: false }, { k: 'blur' }, { k: 'leave' }
    ] as const) kernel.windows.reportInput(id, input)
    await until(async () => (await read('/tmp/wl-shm.out')).includes('pointer leave'))
    const events = (await read('/tmp/wl-shm.out')).split('\n').filter(line => /^(pointer|keyboard) /.test(line) && !line.includes('keymap'))
    expect(events).toEqual([
      'pointer enter surface=7 12 7', 'pointer motion 13 8',
      'pointer button 272 1', 'pointer button 272 0', 'pointer axis 0 -10',
      'keyboard enter keys=0', 'keyboard key 42 1', 'keyboard modifiers 1 0 0', 'keyboard key 30 1', 'keyboard key 30 0', 'keyboard leave', 'pointer leave'
    ])

    // the user resizing the window gives the client a new size, and it draws at that size
    kernel.windows.reportInput(id, { k: 'size', width: 40, height: 20 })
    kernel.windows.reportInput(id, { k: 'size', width: 80, height: 60 })
    await until(async () => (await read('/tmp/wl-shm.out')).includes('resized 80 60'))
    await until(() => fb.pixels.length === 80 * 60 * 4 && fb.pixels[0] === 28)
    expect([fb.width, fb.height]).toEqual([80, 60])
    expect([...fb.pixels.subarray((59 * 80 + 79) * 4, (59 * 80 + 79) * 4 + 3)]).toEqual([28, Math.floor(59 * 255 / 60), Math.floor(79 * 255 / 80)])

    // closing the window tells the client, which then ends
    kernel.windows.close(kernel.windows.list().find(w => w.title === 'wl-shm')!.id, true)
    expect(await client).toBe(0)
    expect(await read('/tmp/wl-shm.out')).toContain('closed')
  }, 60_000)

  it('serves a client built on libwayland-client (wl-lib): window, keymap text, input and resize', async () => {
    const client = kernel.shell.execute(`${env} wl-lib 2 40 20 8000 > /tmp/wl-lib.out 2>&1`)
    await until(async () => (await read('/tmp/wl-lib.out')).includes('done'))
    const out = await read('/tmp/wl-lib.out')
    expect(out).toContain('global 3 xdg_wm_base')
    expect(out).toContain('frame 1')
    expect(out).toContain('keyboard keymap format=1 parsed')
    const fb = kernel.framebuffers.list()[0]!
    expect([fb.width, fb.height]).toEqual([40, 20])
    expect([...fb.pixels.subarray(0, 3)]).toEqual([60, 0, 0])

    const id = kernel.windows.list().find(w => w.title === 'wl-lib')!.id
    for (const input of [
      { k: 'pointer', x: 5, y: 6 }, { k: 'enter' }, { k: 'button', button: 0, down: true }, { k: 'button', button: 0, down: false },
      { k: 'focus' }, { k: 'key', code: 'KeyA', down: true }, { k: 'key', code: 'KeyA', down: false },
      { k: 'key', code: 'ShiftLeft', down: true }, { k: 'key', code: 'KeyA', down: true }, { k: 'key', code: 'KeyA', down: false }, { k: 'key', code: 'ShiftLeft', down: false },
      { k: 'key', code: 'Enter', down: true }, { k: 'key', code: 'Enter', down: false }, { k: 'blur' }, { k: 'leave' }
    ] as const) kernel.windows.reportInput(id, input)
    await until(async () => (await read('/tmp/wl-lib.out')).includes('pointer leave'))
    const events = (await read('/tmp/wl-lib.out')).split('\n').filter(line => /^(pointer|keyboard) /.test(line) && !line.includes('keymap'))
    expect(events).toEqual([
      'pointer enter surface=mine 5 6', 'pointer button 272 1', 'pointer button 272 0',
      'keyboard enter keys=0', 'keyboard key 30 1 a', 'keyboard key 30 0 a',
      'keyboard key 42 1 Shift_L', 'keyboard modifiers 1 0 0', 'keyboard key 30 1 A', 'keyboard key 30 0 A', 'keyboard key 42 0 Shift_L', 'keyboard modifiers 0 0 0',
      'keyboard key 28 1 Return', 'keyboard key 28 0 Return', 'keyboard leave', 'pointer leave'
    ])

    kernel.windows.reportInput(id, { k: 'size', width: 40, height: 20 })
    kernel.windows.reportInput(id, { k: 'size', width: 64, height: 48 })
    await until(async () => (await read('/tmp/wl-lib.out')).includes('resized 64 48'))
    await until(() => fb.pixels.length === 64 * 48 * 4 && fb.pixels[0] === 28)

    kernel.windows.close(id, true)
    expect(await client).toBe(0)
    expect(await read('/tmp/wl-lib.out')).toContain('closed')
  }, 60_000)

  it('runs the shipped demo client: it animates, follows the pointer and quits on Escape', async () => {
    const client = kernel.shell.execute(`wldemo 120 90 > /tmp/wldemo.out 2>&1`)
    await until(() => kernel.windows.list().some(w => w.title === 'wldemo'))
    const id = kernel.windows.list().find(w => w.title === 'wldemo')!.id
    await until(() => kernel.framebuffers.list().length === 1)
    const fb = kernel.framebuffers.list()[0]!
    await until(() => fb.pixels.some(byte => byte !== 0))
    expect([fb.width, fb.height]).toEqual([120, 90])
    const first = fb.pixels.slice()
    await until(() => fb.pixels.some((byte, i) => byte !== first[i]))   // the ball moved

    kernel.windows.reportInput(id, { k: 'pointer', x: 100, y: 80 })
    kernel.windows.reportInput(id, { k: 'enter' })
    const green = () => { for (let i = 0; i + 2 < fb.pixels.length; i += 4) if (fb.pixels[i] === 0x80 && fb.pixels[i + 1] === 0xff && fb.pixels[i + 2] === 0x40) return true; return false }
    await until(green)   // the pointer's square (green: no button down), blue first

    kernel.windows.reportInput(id, { k: 'focus' })
    kernel.windows.reportInput(id, { k: 'key', code: 'Escape', down: true })
    expect(await client).toBe(0)
    await until(() => kernel.framebuffers.list().length === 0)
  }, 60_000)

  it('keeps a large demo window whole, also through a burst of resizes', async () => {
    const client = kernel.shell.execute(`wldemo 700 500 > /tmp/wldemo-big.out 2>&1`)   // 1.4 MB, over what one read returns
    await until(() => kernel.windows.list().some(w => w.title === 'wldemo'))
    const id = kernel.windows.list().find(w => w.title === 'wldemo')!.id
    await until(() => kernel.framebuffers.list().length === 1)
    const fb = kernel.framebuffers.list()[0]!
    const dark = () => { let n = 0; for (let i = 0; i + 2 < fb.pixels.length; i += 4) if (!fb.pixels[i] && !fb.pixels[i + 1] && !fb.pixels[i + 2]) n++; return n }   // the backdrop is never black
    await until(() => fb.pixels.some(byte => byte !== 0))
    await until(() => dark() === 0)

    for (let i = 1; i <= 12; i++) {
      kernel.windows.reportInput(id, { k: 'size', width: 700 + i * 17, height: 500 + i * 11 })
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    await until(() => fb.width === 904 && fb.height === 632 && fb.pixels.length === 904 * 632 * 4)
    await until(() => dark() === 0)

    kernel.windows.reportInput(id, { k: 'focus' })
    kernel.windows.reportInput(id, { k: 'key', code: 'Escape', down: true })
    expect(await client).toBe(0)
  }, 60_000)

  it('runs the shipped SDL game: it hides the pointer, the snake moves, a key steers it and Escape quits', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const client = kernel.shell.execute(`sdlsnake 240 170 > /tmp/sdlsnake.out 2>&1`)
    await until(() => kernel.windows.list().some(w => w.title === 'sdlsnake'))
    const id = kernel.windows.list().find(w => w.title === 'sdlsnake')!.id
    await until(() => kernel.framebuffers.list().length === 1)
    const fb = kernel.framebuffers.list()[0]!
    await until(() => fb.pixels.some(byte => byte !== 0))
    expect([fb.width, fb.height]).toEqual([240, 170])
    kernel.windows.reportInput(id, { k: 'focus' })
    expect(fb.pointerCursor).toBe('default')
    kernel.windows.reportInput(id, { k: 'pointer', x: 50, y: 40 })
    kernel.windows.reportInput(id, { k: 'enter' })
    await until(() => fb.pointerCursor === 'none')   // the game hid the pointer, so the window's cursor goes
    const first = fb.pixels.slice()
    await until(() => fb.pixels.some((byte, i) => byte !== first[i]))   // it moved
    kernel.windows.reportInput(id, { k: 'key', code: 'ArrowUp', down: true })
    kernel.windows.reportInput(id, { k: 'key', code: 'ArrowUp', down: false })
    kernel.windows.reportInput(id, { k: 'key', code: 'Escape', down: true })
    expect(await client).toBe(0)
    await until(() => kernel.framebuffers.list().length === 0)
  }, 60_000)

  it('serves an SDL 3 program through its Wayland driver: window surface, pointer, keys, text and resize', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const client = kernel.shell.execute(`${env} sdl-win 160 100 60000 > /tmp/sdl-win.out 2>&1`)
    await until(() => kernel.framebuffers.list().length === 1)
    const fb = kernel.framebuffers.list()[0]!
    const px = (x: number, y: number) => [...fb.pixels.subarray((y * fb.width + x) * 4, (y * fb.width + x) * 4 + 3)]
    await until(() => fb.pixels.some(byte => byte !== 0))
    expect([fb.width, fb.height]).toEqual([160, 100])
    await until(() => px(159, 99)[0] === 60)   // blue first: the gradient with 60 for blue, the corner is all but full red and green
    expect(px(159, 99)).toEqual([60, Math.floor(99 * 255 / 100), Math.floor(159 * 255 / 160)])
    const out = () => read('/tmp/sdl-win.out')
    expect(await out()).toContain('driver wayland')
    expect(await out()).not.toContain('ERROR')

    const id = kernel.windows.list().find(w => w.title === 'sdl-win')!.id
    for (const input of [
      { k: 'pointer', x: 12, y: 7 }, { k: 'enter' }, { k: 'pointer', x: 13, y: 8 }, { k: 'button', button: 0, down: true }, { k: 'button', button: 0, down: false },
      { k: 'focus' }, { k: 'key', code: 'KeyA', down: true }, { k: 'key', code: 'KeyA', down: false },
      { k: 'key', code: 'ShiftLeft', down: true }, { k: 'key', code: 'KeyA', down: true }, { k: 'key', code: 'KeyA', down: false }, { k: 'key', code: 'ShiftLeft', down: false }
    ] as const) kernel.windows.reportInput(id, input)
    await until(async () => (await out()).includes('key Left Shift up'))
    expect(fb.pointerCursor).toBe('pointer')   // SDL's system cursor reaches the window as a CSS cursor
    // a cursor the client drew arrives as an image with its hotspot, and a named cursor after it takes its place
    kernel.windows.reportInput(id, { k: 'key', code: 'F6', down: true })
    kernel.windows.reportInput(id, { k: 'key', code: 'F6', down: false })
    await until(() => fb.pointerImage !== undefined)
    expect(fb.pointerImage).toMatchObject({ width: 8, height: 6, x: 2, y: 1 })
    expect([...fb.pointerImage!.data.subarray(0, 4)]).toEqual([0, 0, 255, 255])   // blue, green, red, alpha
    kernel.windows.reportInput(id, { k: 'key', code: 'F7', down: true })
    kernel.windows.reportInput(id, { k: 'key', code: 'F7', down: false })
    await until(() => fb.pointerCursor === 'crosshair' && fb.pointerImage === undefined)
    const events = (await out()).split('\n').filter(line => /^(mouse|motion|button|focus|key|text) /.test(line))
    expect(events).toEqual([
      'mouse enter', 'motion 12 7', 'motion 13 8', 'button 1 1', 'button 1 0', 'focus gained',
      'key A down', 'text a', 'key A up', 'key Left Shift down', 'key A down', 'text A', 'key A up', 'key Left Shift up', 'key F6 down', 'key F6 up', 'key F7 down', 'key F7 up'
    ])

    // the user resizing the window: SDL gets a new size, makes a new window surface and the compositor shows it whole
    kernel.windows.reportInput(id, { k: 'size', width: 160, height: 100 })
    kernel.windows.reportInput(id, { k: 'size', width: 200, height: 140 })
    await until(async () => (await out()).includes('resized 200 140'))
    await until(() => fb.width === 200 && fb.height === 140 && px(199, 139)[0] === 200)
    expect(px(199, 139)).toEqual([200, Math.floor(139 * 255 / 140), Math.floor(199 * 255 / 200)])

    // window states: SDL asks and the window follows; the user changing the state reaches SDL as well
    const tap = (code: string) => { kernel.windows.reportInput(id, { k: 'key', code, down: true }); kernel.windows.reportInput(id, { k: 'key', code, down: false }) }
    const state = () => kernel.windows.list().find(w => w.id === id)!.state
    tap('F1')
    await until(() => state() === 'maximized')
    await until(async () => (await out()).includes('\nmaximized'))
    tap('F2')
    await until(() => state() === 'normal')
    await until(async () => (await out()).includes('restored'))
    tap('F3')
    await until(() => state() === 'fullscreen')
    await until(async () => (await out()).includes('\nfullscreen'))
    tap('F4')
    await until(() => state() === 'normal')
    await until(async () => (await out()).includes('windowed'))
    kernel.windows.update(id, { state: 'maximized' })
    await until(async () => (await out()).split('\nmaximized').length > 2)
    kernel.windows.update(id, { state: 'normal' })
    tap('F5')
    await until(() => state() === 'minimized')

    // closing the window tells SDL, which ends the program
    kernel.windows.close(id, true)
    expect(await client).toBe(0)
    expect(await out()).toContain('close')
  }, 90_000)

  it('runs the shipped SDL paint program: a ring cursor in the brush color over the picture, strokes in the chosen color, an arrow over the palette', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const client = kernel.shell.execute(`${env} sdlpaint 200 150 > /tmp/sdlpaint.out 2>&1`)
    await until(() => kernel.framebuffers.list().length === 1)
    const fb = kernel.framebuffers.list()[0]!
    const px = (x: number, y: number) => [...fb.pixels.subarray((y * fb.width + x) * 4, (y * fb.width + x) * 4 + 3)]
    await until(() => px(100, 100)[0] === 0xfa)   // paper
    const id = kernel.windows.list().find(w => w.title === 'sdlpaint')!.id
    const send = (...inputs: Parameters<typeof kernel.windows.reportInput>[1][]) => { for (const input of inputs) kernel.windows.reportInput(id, input) }
    send({ k: 'pointer', x: 100, y: 100 }, { k: 'enter' }, { k: 'focus' })
    const centre = () => { const i = fb.pointerImage; return i ? [...i.data.subarray(((i.y * i.width) + i.x + 4) * 4, ((i.y * i.width) + i.x + 4) * 4 + 4)] : [] }
    await until(() => fb.pointerImage !== undefined)
    const first = fb.pointerImage!
    expect([first.x, first.y]).toEqual([first.width >> 1, first.height >> 1])   // the hotspot is the middle of the ring
    send({ k: 'key', code: 'Digit2', down: true }, { k: 'key', code: 'Digit2', down: false })   // red
    await until(() => fb.pointerImage !== first && centre()[2] === 0xe5)   // the ring is red now (blue, green, red, alpha)
    await new Promise(resolve => setTimeout(resolve, 300))
    send({ k: 'pointer', x: 60, y: 80 }, { k: 'button', button: 0, down: true }, { k: 'pointer', x: 120, y: 80 }, { k: 'button', button: 0, down: false })
    await until(() => px(90, 80)[2] === 0xe5)    // blue first: red 0xe5 is the last byte of three
    expect(px(90, 80)).toEqual([0x35, 0x39, 0xe5])
    expect(px(90, 130)[0]).toBe(0xfa)             // untouched paper
    send({ k: 'pointer', x: 20, y: 10 })          // over the palette
    await until(() => fb.pointerCursor === 'pointer')
    send({ k: 'key', code: 'Escape', down: true }, { k: 'key', code: 'Escape', down: false })
    expect(await client).toBe(0)
  }, 90_000)

  it('takes a window away when its client goes', async () => {
    const client = kernel.shell.execute(`${env} wl-shm 1 16 16 300 > /tmp/wl-shm2.out 2>&1`)
    await until(async () => (await read('/tmp/wl-shm2.out')).includes('done'))
    expect(kernel.framebuffers.list()).toHaveLength(1)
    expect(await client).toBe(0)
    await until(() => kernel.framebuffers.list().length === 0)
  }, 60_000)

  it('shares the clipboard between clients and with the browser, and hands a drop on a window to its client', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const ids = () => kernel.windows.list().filter(w => w.title === 'sdl-clip').map(w => w.id)
    const clientA = kernel.shell.execute(`${env} sdl-clip alpha > /tmp/clip-a.out 2>&1`)
    await until(() => ids().length === 1)
    const a = ids()[0]!
    await until(async () => (await read('/tmp/clip-a.out')).includes('shown'))
    const clientB = kernel.shell.execute(`${env} sdl-clip beta > /tmp/clip-b.out 2>&1`)
    await until(() => ids().length === 2)
    const b = ids().find(id => id !== a)!
    await until(async () => (await read('/tmp/clip-b.out')).includes('shown'))
    const outA = () => read('/tmp/clip-a.out')
    const outB = () => read('/tmp/clip-b.out')
    const tap = (id: string, code: string) => { kernel.windows.reportInput(id, { k: 'key', code, down: true }); kernel.windows.reportInput(id, { k: 'key', code, down: false }) }

    // what a client copies is offered to the next one that has the keyboard, and sent out to the browser
    kernel.windows.reportInput(a, { k: 'focus' })
    await until(async () => (await outA()).includes('focus gained'))
    tap(a, 'F1')
    await until(async () => (await outA()).includes('set '))
    await until(() => kernel.framebuffers.list().some(fb => fb.copiedText === 'alpha'))
    kernel.windows.reportInput(a, { k: 'blur' })
    kernel.windows.reportInput(b, { k: 'focus' })
    await until(async () => (await outB()).includes('clipboard update'))
    tap(b, 'F2')
    await until(async () => (await outB()).includes('clipboard [alpha] has=1'))

    // text from the browser's clipboard becomes the clipboard of whoever has the keyboard
    kernel.windows.reportInput(b, { k: 'paste', text: 'from the browser' })
    await until(async () => (await outB()).split('clipboard update').length > 2)
    tap(b, 'F2')
    await until(async () => (await outB()).includes('clipboard [from the browser] has=1'))
    kernel.windows.reportInput(b, { k: 'blur' })
    kernel.windows.reportInput(a, { k: 'focus' })
    await until(async () => (await outA()).split('focus gained').length > 2)
    tap(a, 'F2')
    await until(async () => (await outA()).includes('clipboard [from the browser] has=1'))

    // text dropped on a window, and a list of URIs, reach its client as drops
    kernel.windows.reportInput(b, { k: 'pointer', x: 20, y: 30 })
    kernel.windows.reportInput(b, { k: 'enter' })
    kernel.windows.reportInput(b, { k: 'drop', x: 20, y: 30, text: 'some dropped words' })
    await until(async () => (await outB()).includes('drop text [some dropped words]'))
    await until(async () => (await outB()).includes('drop complete'))
    kernel.windows.reportInput(b, { k: 'drop', x: 21, y: 31, text: 'file:///tmp/one.txt\r\nfile:///tmp/two.txt\r\n', uris: true })
    await until(async () => (await outB()).includes('drop file [/tmp/two.txt]'))
    expect(await outB()).toContain('drop file [/tmp/one.txt]')

    kernel.windows.close(a, true)
    kernel.windows.close(b, true)
    expect(await clientA).toBe(0)
    expect(await clientB).toBe(0)
  }, 90_000)

  it('runs the shipped SDL clipboard program: C copies to the browser, pasted text and a drop change the picture', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const client = kernel.shell.execute(`${env} sdlclip > /tmp/sdlclip.out 2>&1`)
    await until(() => kernel.framebuffers.list().length === 1)
    const fb = kernel.framebuffers.list()[0]!
    const id = kernel.windows.list().find(w => w.title === 'sdlclip')!.id
    const picture = () => Buffer.from(fb.pixels).toString('base64')
    await until(() => fb.pixels.some(byte => byte !== 0))
    const tap = (code: string) => { kernel.windows.reportInput(id, { k: 'key', code, down: true }); kernel.windows.reportInput(id, { k: 'key', code, down: false }) }
    kernel.windows.reportInput(id, { k: 'focus' })
    const before = picture()

    tap('KeyC')
    await until(() => fb.copiedText === 'hello from sdlclip 1')
    const copied = picture()
    expect(copied).not.toBe(before)

    kernel.windows.reportInput(id, { k: 'paste', text: 'pasted from the page' })
    await until(() => picture() !== copied)
    const pasted = picture()
    kernel.windows.reportInput(id, { k: 'drop', x: 30, y: 30, text: 'a dropped line' })
    await until(() => picture() !== pasted)

    kernel.windows.close(id, true)
    expect(await client).toBe(0)
    expect(await read('/tmp/sdlclip.out')).not.toContain('ERROR')
  }, 60_000)

  it('runs the shipped SDL gamepad program on a browser pad: found once a button is pressed, buttons and sticks change the picture, unplugging is noticed', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const navigatorPads = globalThis.navigator as unknown as { getGamepads: () => unknown[] }
    const before = navigatorPads.getGamepads
    const pad = {
      id: 'Test Pad (STANDARD GAMEPAD Vendor: 0000 Product: 0000)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0]
    }
    let plugged = false
    Object.defineProperty(globalThis.navigator, 'getGamepads', { value: () => plugged ? [pad, null, null, null] : [null, null, null, null], configurable: true })
    try {
      const client = kernel.shell.execute(`${env} sdlpad > /tmp/sdlpad.out 2>&1`)
      await until(() => kernel.framebuffers.list().length === 1)
      const fb = kernel.framebuffers.list()[0]!
      const id = kernel.windows.list().find(w => w.title === 'sdlpad')!.id
      const picture = () => Buffer.from(fb.pixels).toString('base64')
      await until(() => fb.pixels.some(byte => byte !== 0))
      const none = picture()

      plugged = true
      await until(async () => (await read('/tmp/sdlpad.out')).includes('17 buttons, 4 axes, standard layout'), 30_000)
      await until(() => picture() !== none)
      const idle = picture()

      pad.buttons[0]!.pressed = true
      await until(async () => (await read('/tmp/sdlpad.out')).includes('a down'))
      await until(() => picture() !== idle)
      const held = picture()
      pad.buttons[0]!.pressed = false
      await until(async () => (await read('/tmp/sdlpad.out')).includes('a up'))
      await until(() => picture() === idle)

      pad.axes[0] = 0.5
      pad.buttons[12]!.pressed = true
      await until(async () => (await read('/tmp/sdlpad.out')).includes('dpup down'))
      await until(() => picture() !== idle && picture() !== held)

      pad.connected = false
      await until(async () => (await read('/tmp/sdlpad.out')).includes('gamepad gone'))
      await until(() => picture() === none)

      kernel.windows.close(id, true)
      expect(await client).toBe(0)
      expect(await read('/tmp/sdlpad.out')).not.toContain('ERROR')
    } finally {
      Object.defineProperty(globalThis.navigator, 'getGamepads', { value: before, configurable: true })
    }
  }, 90_000)

  it('runs the shipped OpenGL ES program: SDL draws through its EGL, the commands go to /dev/gl<N> and the frame that comes back is the window', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const { made, factory } = fakeGlSurfaces()
    const previous = setGlSurfaceFactory(factory)
    try {
      const client = kernel.shell.execute(`${env} sdlgl 64 48 > /tmp/sdlgl.out 2>&1`)
      await until(() => kernel.framebuffers.list().length === 1)
      const fb = kernel.framebuffers.list()[0]!
      const id = kernel.windows.list().find(w => w.title === 'sdlgl')!.id
      await until(async () => (await read('/tmp/sdlgl.out')).includes('OpenGL ES 2.0 ecmaOS'), 30_000)
      const color = () => [...fb.pixels.subarray(0, 3)]
      await until(() => color().join() === '51,51,51')   // the first clear: gray 0.2
      expect(made).toHaveLength(1)
      expect(made[0]!.viewports.at(-1)).toEqual([0, 0, 64, 48])

      kernel.windows.reportInput(id, { k: 'focus' })
      for (const [code, name, rgb] of [['KeyR', 'red', [0, 0, 255]], ['KeyB', 'blue', [255, 0, 0]], ['KeyG', 'green', [0, 255, 0]]] as const) {
        kernel.windows.reportInput(id, { k: 'key', code, down: true })
        kernel.windows.reportInput(id, { k: 'key', code, down: false })
        await until(async () => (await read('/tmp/sdlgl.out')).includes(`sdlgl: ${name}`))
        await until(() => color().join() === rgb.join())
      }
      expect(glContextAt(0)).toBeDefined()

      kernel.windows.close(id, true)
      expect(await client).toBe(0)
      expect(await read('/tmp/sdlgl.out')).not.toContain('ERROR')
      await until(() => glContextAt(0) === undefined)   // the context went with the process
    } finally {
      setGlSurfaceFactory(previous)
    }
  }, 90_000)

  it('runs sdlgears: three gears, each its own buffer, drawn with depth testing', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const { made, factory } = fakeGlSurfaces()
    const previous = setGlSurfaceFactory(factory)
    try {
      const client = kernel.shell.execute(`${env} sdlgears 64 48 > /tmp/sdlgears.out 2>&1`)
      await until(() => kernel.framebuffers.list().length === 1)
      const id = kernel.windows.list().find(w => w.title === 'sdlgears')!.id
      await until(async () => (await read('/tmp/sdlgears.out')).includes('OpenGL ES 2.0 ecmaOS'), 30_000)
      const calls = () => made[0]!.calls
      await until(() => calls().filter(([m]) => m === 'drawArrays').length >= 6)
      expect(calls().some(([m, a]) => m === 'enable' && a[0] === 0xb71)).toBe(true)   // DEPTH_TEST
      expect(calls().filter(([m]) => m === 'createBuffer')).toHaveLength(3)
      expect(calls().find(([m]) => m === 'drawArrays')![1][2]).toBeGreaterThan(100)
      kernel.windows.close(id, true)
      expect(await client).toBe(0)
      expect(await read('/tmp/sdlgears.out')).toContain('OpenGL ES 2.0 ecmaOS')
    } finally {
      setGlSurfaceFactory(previous)
    }
  }, 90_000)

  // needs game data, which is not in the repo: DOOM_WAD=/path/to/freedoom1.wad pnpm vitest run tests/tree/wayland.test.ts
  it.skipIf(!doomWad)('runs doom: the engine starts from a WAD and draws frames into a window and plays sounds', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    await kernel.filesystem.fs.writeFile('/tmp/doom.wad', new Uint8Array(process.getBuiltinModule('node:fs').readFileSync(doomWad!)))
    const client = kernel.shell.execute(`${env} doom -iwad /tmp/doom.wad > /tmp/doom.out 2>&1`)
    await until(() => kernel.framebuffers.list().length === 1, 60_000)
    const id = kernel.windows.list()[0]!.id   // the engine retitles it with the game's name
    await until(() => kernel.framebuffers.list()[0]!.pixels.some(byte => byte !== 0), 30_000)
    // the demo that plays behind the title has sound effects: the mixer sends them as stereo samples
    const heard = () => played.some(chunk => new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length >> 1).some(sample => sample !== 0))
    await until(heard, 90_000)
    kernel.windows.close(id, true)
    await client
    expect(await read('/tmp/doom.out')).toContain('Doom Generic')
  }, 180_000)
})
