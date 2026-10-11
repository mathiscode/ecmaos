import { describe, expect, it } from 'vitest'
import { DisplayOwner, attachDisplay, keepDisplay, type DisplaySurface, type KeyMods, type MirroredTerminal, type RemoteCall } from '#lib/remote-display.ts'
import { machineLockName } from '#lib/machine-lock.ts'
import { displayAddress, displayRequest } from '#lib/display-client.ts'
import { remoteKinds } from '#lib/presenters/remote.ts'

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
  let sendSize: (cols: number, rows: number) => void = () => {}
  const surface: DisplaySurface = {
    lost: reason => { log.push(`lost ${reason}`) },
    open: (cols, rows, screen) => { log.push(`open ${cols}x${rows} ${screen}`) },
    write: data => { log.push(`write ${data}`) },
    onInput: (data, key) => { sendData = data; sendKey = key },
    onResize: size => { sendSize = size; size(80, 24) }
  }
  return { surface, log, resize: (cols: number, rows: number) => sendSize(cols, rows), type: (text: string) => sendData(text), press: (key: string, mods: KeyMods) => sendKey(key, mods) }
}

/** A lock manager: `request` runs its callback once the name is free, as Web Locks do (a shared request waits for the holder too) */
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
    request: (name: string, a: unknown, b?: unknown) => {
      const callback = (typeof a === 'function' ? a : b) as () => Promise<unknown> | unknown
      const signal = (typeof a === 'object' ? (a as { signal?: AbortSignal }).signal : undefined)
      if (!held.has(name)) return grant(name, callback)
      return new Promise<unknown>((resolve, reject) => {
        const queue = waiting.get(name) ?? waiting.set(name, []).get(name)!
        const turn = () => { if (signal?.aborted) return; grant(name, callback).then(resolve, reject) }
        queue.push(turn)
        signal?.addEventListener('abort', () => { queue.splice(queue.indexOf(turn) >>> 0, 1); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    }
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

describe('remote display: sizes, browser calls, reconnect', () => {
  it('sizes a tty to the smallest display on it', async () => {
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, () => tty.terminal, undefined)
    const a = fakeSurface()
    const b = fakeSurface()
    const closeA = await attachDisplay(store, 0, a.surface)
    const closeB = await attachDisplay(store, 0, b.surface)
    await settle()
    a.resize(120, 40)
    b.resize(100, 50)
    await settle()
    expect(tty.sizes.at(-1)).toEqual([100, 40])
    closeB()
    await settle()
    expect(tty.sizes.at(-1)).toEqual([120, 40])
    closeA(); owner.close()
  })

  const doing = (log: string[]) => (kind: string, params: Record<string, unknown>): RemoteCall => {
    log.push(`${kind}:${JSON.stringify(params)}`)
    return { done: Promise.resolve({ text: 'from the display' }), cancel: () => { log.push(`cancelled ${kind}`) } }
  }

  it('has a browser call done by the display on the tty, and answers with its result', async () => {
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, () => tty.terminal, undefined)
    expect(owner.present(0, 'clipboard-read', {})).toBeUndefined()
    const log: string[] = []
    const close = await attachDisplay(store, 0, fakeSurface().surface, { present: doing(log) })
    const call = owner.present(0, 'clipboard-read', { a: 1 })!
    await expect(call.done).resolves.toEqual({ text: 'from the display' })
    expect(log).toEqual(['clipboard-read:{"a":1}'])
    expect(owner.present(3, 'clipboard-read', {})).toBeUndefined()
    close(); owner.close()
  })

  it('sends the call to the display the user last typed at', async () => {
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, () => tty.terminal, undefined)
    const first: string[] = []
    const second: string[] = []
    const a = fakeSurface()
    const closeA = await attachDisplay(store, 0, a.surface, { present: doing(first) })
    const closeB = await attachDisplay(store, 0, fakeSurface().surface, { present: doing(second) })
    await settle(10)
    a.type('x')
    await settle()
    await owner.present(0, 'notify', {})!.done
    expect(first).toEqual(['notify:{}'])
    expect(second).toEqual([])
    closeA(); closeB(); owner.close()
  })

  it('passes a cancel to the display, and fails a call whose display went away', async () => {
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, () => tty.terminal, undefined)
    const log: string[] = []
    const never = (kind: string): RemoteCall => ({ done: new Promise(() => {}), cancel: () => { log.push(`cancelled ${kind}`) } })
    const close = await attachDisplay(store, 0, fakeSurface().surface, { present: kind => never(kind) })
    owner.present(0, 'speak', {})!.cancel()
    await settle()
    expect(log).toEqual(['cancelled speak'])

    const stranded = owner.present(0, 'speak', {})!
    const outcome = expect(stranded.done).rejects.toThrow('the display went away')
    close()
    await outcome
    owner.close()
  })

  it('tells a display with no way to do it that it cannot', async () => {
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, () => tty.terminal, undefined)
    const close = await attachDisplay(store, 0, fakeSurface().surface)
    await expect(owner.present(0, 'notify', {})!.done).rejects.toThrow('cannot do that')
    close(); owner.close()
  })

  it('attaches again, from a fresh screen, when the machine comes back', async () => {
    const { locks, held } = fakeLocks()
    const first = fakeTerminal()
    const second = fakeTerminal()
    const display = fakeSurface()

    // the first machine: its tab holds the machine lock and answers displays
    void locks.request(machineLockName(store), () => new Promise(() => {}))
    let owner = new DisplayOwner(store, () => first.terminal, locks)
    const keeping = keepDisplay(store, 0, display.surface, { locks, retryMs: 20, timeoutMs: 100 })
    await settle(100)
    expect(display.log).toEqual(['open 100x30 SCREEN'])

    // that tab reloads: it lets go of the machine and stops answering
    owner.close()
    held.get(machineLockName(store))!.release()
    await settle(100)
    expect(display.log.at(-1)).toContain('lost')

    // a new machine starts
    void locks.request(machineLockName(store), () => new Promise(() => {}))
    owner = new DisplayOwner(store, () => second.terminal, locks)
    await settle(200)
    expect(display.log.filter(line => line.startsWith('open'))).toHaveLength(2)
    display.type('after')
    await settle()
    expect(second.typed).toEqual(['after'])
    expect(first.typed).toEqual([])

    keeping.close()
    owner.close()
  })

  it('reports a first refusal once and keeps trying', async () => {
    const display = fakeSurface()
    const keeping = keepDisplay(store, 0, display.surface, { retryMs: 20, timeoutMs: 30 })
    await settle(150)
    expect(display.log.filter(line => line.startsWith('lost'))).toHaveLength(1)
    const tty = fakeTerminal()
    const owner = new DisplayOwner(store, () => tty.terminal, undefined)
    await settle(150)
    expect(display.log.some(line => line.startsWith('open'))).toBe(true)
    keeping.close(); owner.close()
  })
})

describe('a remote key', () => {
  it('reaches every onKey listener, as the keyboard does, until the listener is disposed', async () => {
    const { Kernel } = await import('#kernel.ts')
    const { DefaultFilesystemOptions } = await import('#filesystem.ts')
    const { TestDomOptions, TestLogOptions } = await import('./fixtures/kernel.fixtures')
    const kernel = new Kernel({ dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, credentials: { username: 'root', password: 'root' } })
    await kernel.boot()
    const terminal = kernel.terminal
    const mods: KeyMods = { key: 'a', ctrl: false, alt: false, shift: false, meta: false }
    const seen: string[] = []
    // a password prompt, or a program reading keys, subscribes itself like this
    const subscription = terminal.onKey(({ key }) => { seen.push(key) })
    terminal.remoteKey('a', mods)
    expect(seen).toEqual(['a'])
    subscription.dispose()
    terminal.remoteKey('b', { ...mods, key: 'b' })
    expect(seen).toEqual(['a'])
  }, 60_000)
})

describe('the browser calls a display does', () => {
  const kernel = (events: unknown[] = []) => ({
    filesystem: { fs: { readFile: async () => new Uint8Array([1, 2, 3]) } },
    events: { dispatch: (_name: unknown, detail: unknown) => { events.push(detail) } }
  }) as never

  it('reads a file for a download in the owner, so the display needs no filesystem', async () => {
    const params = await remoteKinds['download']!.prepare!(kernel(), undefined as never, { path: '/home/a/report.txt' })
    expect(params).toEqual({ name: 'report.txt', bytes: new Uint8Array([1, 2, 3]) })
    await expect(remoteKinds['download']!.prepare!(kernel(), undefined as never, {})).rejects.toThrow('missing path')
  })

  it('writes the files a display picked into the directory the program named', async () => {
    const written: Array<[string, Uint8Array]> = []
    const events: unknown[] = []
    const shell = { context: { fs: { promises: { writeFile: async (path: string, data: Uint8Array) => { written.push([path, data]) } } } } } as never
    const answer = [{ name: 'a.txt', data: new Uint8Array([9]) }, { name: 'b.txt', data: new Uint8Array([8]) }]
    const outcome = await remoteKinds['upload']!.finish!(kernel(events), shell, answer, { directory: '/home/bob/' })
    expect(outcome).toEqual({ uploaded: ['a.txt', 'b.txt'], errors: [] })
    expect(written.map(([path]) => path)).toEqual(['/home/bob/a.txt', '/home/bob/b.txt'])
    expect(events).toHaveLength(2)
  })

  it('tells a cancelled picker from an empty one', async () => {
    const shell = { context: { fs: { promises: { writeFile: async () => {} } } } } as never
    const finish = remoteKinds['upload']!.finish!
    expect(await finish(kernel(), shell, null, { directory: '/x' })).toEqual({ uploaded: [], errors: [] })
    expect(await finish(kernel(), shell, [], { directory: '/x' })).toEqual({ uploaded: [], errors: ['No file selected'] })
  })

  it('reports a file it could not write and goes on', async () => {
    const shell = { context: { fs: { promises: { writeFile: async (path: string) => { if (path.endsWith('bad')) throw new Error('EACCES') } } } } } as never
    const outcome = await remoteKinds['upload']!.finish!(kernel(), shell, [{ name: 'bad', data: new Uint8Array() }, { name: 'ok', data: new Uint8Array() }], { directory: '/x' })
    expect(outcome).toEqual({ uploaded: ['ok'], errors: ['Failed to upload bad: EACCES'] })
  })

  it('has a way to do every call the owner routes', () => {
    expect(Object.keys(remoteKinds).sort()).toEqual(['clipboard-read', 'clipboard-write', 'download', 'external', 'notify', 'speak', 'upload'])
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
