import { describe, expect, it } from 'vitest'
import { DisplayOwner, attachDisplay, type DisplaySurface, type KeyMods, type MirroredTerminal } from '#lib/remote-display.ts'
import { displayAddress, displayRequest } from '#lib/display-client.ts'

const store = 'zenfs-test'
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

function fakeTerminal() {
  const sinks = new Set<(data: string | Uint8Array) => void>()
  const typed: string[] = []
  const keys: Array<[string, KeyMods]> = []
  const sizes: Array<[number, number]> = []
  const terminal: MirroredTerminal = {
    cols: 100, rows: 30,
    serialize: () => 'SCREEN',
    mirror: sink => { sinks.add(sink); return () => { sinks.delete(sink) } },
    remoteData: data => { typed.push(data) },
    remoteKey: (key, mods) => { keys.push([key, mods]) },
    remoteResize: (cols, rows) => { sizes.push([cols, rows]) }
  }
  return { terminal, sinks, typed, keys, sizes, write: (data: string) => { for (const sink of sinks) sink(data) } }
}

function fakeSurface() {
  const log: string[] = []
  let sendData: (text: string) => void = () => {}
  let sendKey: (key: string, mods: KeyMods) => void = () => {}
  const surface: DisplaySurface = {
    open: (cols, rows, screen) => { log.push(`open ${cols}x${rows} ${screen}`) },
    write: data => { log.push(`write ${data}`) },
    onInput: (data, key) => { sendData = data; sendKey = key },
    onResize: size => { size(80, 24) }
  }
  return { surface, log, type: (text: string) => sendData(text), press: (key: string, mods: KeyMods) => sendKey(key, mods) }
}

/** A lock manager of one: `request` runs its callback once the name is free, as Web Locks do */
function fakeLocks() {
  const held = new Map<string, { release: () => void }>()
  const waiting = new Map<string, Array<() => void>>()
  const grant = (name: string, callback: () => Promise<unknown> | unknown) => {
    let kill!: () => void
    const killed = new Promise<void>(resolve => { kill = resolve })
    held.set(name, { release: kill })
    return Promise.race([Promise.resolve(callback()), killed]).finally(() => {
      held.delete(name)
      waiting.get(name)?.shift()?.()
    })
  }
  const locks = {
    request: (name: string, callback: () => Promise<unknown> | unknown) =>
      held.has(name)
        ? new Promise<unknown>((resolve, reject) => { (waiting.get(name) ?? waiting.set(name, []).get(name)!).push(() => grant(name, callback).then(resolve, reject)) })
        : grant(name, callback)
  } as unknown as LockManager
  return { locks, held }
}

describe('remote display', () => {
  it('shows the screen, streams output after it in order, and sends typing back', async () => {
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, n => n === 1 ? tty.terminal : undefined, undefined)
    const display = fakeSurface()
    const close = await attachDisplay(store, 1, display.surface)
    expect(display.log).toEqual(['open 100x30 SCREEN'])

    tty.write('one')
    tty.write('two')
    await settle()
    expect(display.log.slice(1)).toEqual(['write one', 'write two'])

    display.type('ls\r')
    display.press('\r', { key: 'Enter', ctrl: false, alt: false, shift: false, meta: false })
    await settle()
    expect(tty.typed).toEqual(['ls\r'])
    expect(tty.keys[0]?.[0]).toBe('\r')
    expect(tty.sizes).toEqual([[80, 24]])

    close()
    await settle()
    expect(tty.sinks.size).toBe(0)
    expect(owner.attached).toBe(0)
    owner.close()
  })

  it('refuses a tty the machine does not have', async () => {
    const owner = new DisplayOwner(store, () => undefined, undefined)
    await expect(attachDisplay(store, 5, fakeSurface().surface)).rejects.toThrow('tty5 is not running')
    owner.close()
  })

  it('says so when no machine answers', async () => {
    await expect(attachDisplay(store, 0, fakeSurface().surface, { timeoutMs: 80 })).rejects.toThrow('no machine answered')
  })

  it('stops mirroring when the display page goes away, through its lock', async () => {
    const tty = fakeTerminal()
    const { locks, held } = fakeLocks()
    const owner = new DisplayOwner(store, () => tty.terminal, locks)
    const close = await attachDisplay(store, 0, fakeSurface().surface, { locks })
    await settle()
    expect(owner.attached).toBe(1)
    // the page dies without saying goodbye: only the lock is let go
    const [name, lock] = [...held.entries()][0]!
    expect(name).toContain('display-session')
    lock.release()
    await settle()
    expect(owner.attached).toBe(0)
    expect(tty.sinks.size).toBe(0)
    close()
    owner.close()
  })

  it('serves two displays on one tty', async () => {
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, () => tty.terminal, undefined)
    const a = fakeSurface()
    const b = fakeSurface()
    const closeA = await attachDisplay(store, 0, a.surface)
    const closeB = await attachDisplay(store, 0, b.surface)
    tty.write('hello')
    await settle()
    expect(a.log).toContain('write hello')
    expect(b.log).toContain('write hello')
    closeA(); closeB(); owner.close()
  })
})

describe('display address', () => {
  it('reads a tty and a machine from the address', () => {
    expect(displayRequest('')).toBeUndefined()
    expect(displayRequest('?display=3')).toEqual({ tty: 3, store: 'zenfs' })
    expect(displayRequest('?display=0&machine=work')).toEqual({ tty: 0, store: 'zenfs-work' })
    expect(displayRequest('?display=9')).toHaveProperty('error')
    expect(displayRequest('?display=1&machine=Bad Name')).toHaveProperty('error')
  })
  it('keeps the machine when building the address', () => {
    expect(displayAddress('http://x/?machine=work', 2)).toBe('http://x/?machine=work&display=2')
  })
})
