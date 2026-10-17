import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

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
  const env = 'XDG_RUNTIME_DIR=/run/user/0 WAYLAND_DISPLAY=wayland-0'
  const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf8').catch(() => '')

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
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
    const events = (await out()).split('\n').filter(line => /^(mouse|motion|button|focus|key|text) /.test(line))
    expect(events).toEqual([
      'mouse enter', 'motion 12 7', 'motion 13 8', 'button 1 1', 'button 1 0', 'focus gained',
      'key A down', 'text a', 'key A up', 'key Left Shift down', 'key A down', 'text A', 'key A up', 'key Left Shift up'
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

  it('runs the shipped SDL paint program: a crosshair over the picture, strokes in the chosen color, an arrow over the palette', async () => {
    await until(() => kernel.framebuffers.list().length === 0)
    const client = kernel.shell.execute(`${env} sdlpaint 200 150 > /tmp/sdlpaint.out 2>&1`)
    await until(() => kernel.framebuffers.list().length === 1)
    const fb = kernel.framebuffers.list()[0]!
    const px = (x: number, y: number) => [...fb.pixels.subarray((y * fb.width + x) * 4, (y * fb.width + x) * 4 + 3)]
    await until(() => px(100, 100)[0] === 0xfa)   // paper
    const id = kernel.windows.list().find(w => w.title === 'sdlpaint')!.id
    const send = (...inputs: Parameters<typeof kernel.windows.reportInput>[1][]) => { for (const input of inputs) kernel.windows.reportInput(id, input) }
    send({ k: 'pointer', x: 100, y: 100 }, { k: 'enter' }, { k: 'focus' })
    await until(() => fb.pointerCursor === 'crosshair')
    send({ k: 'key', code: 'Digit2', down: true }, { k: 'key', code: 'Digit2', down: false })   // red
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
})
