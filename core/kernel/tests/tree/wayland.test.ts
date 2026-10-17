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
    await kernel.filesystem.fs.writeFile('/bin/wl-lib', load(`${root}/tests/tree/wasi/fixtures/wl-lib.wasm`), { mode: 0o755 })
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

  it('takes a window away when its client goes', async () => {
    const client = kernel.shell.execute(`${env} wl-shm 1 16 16 300 > /tmp/wl-shm2.out 2>&1`)
    await until(async () => (await read('/tmp/wl-shm2.out')).includes('done'))
    expect(kernel.framebuffers.list()).toHaveLength(1)
    expect(await client).toBe(0)
    await until(() => kernel.framebuffers.list().length === 0)
  }, 60_000)
})
