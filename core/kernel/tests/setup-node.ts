import { afterAll } from 'vitest'
import { attach_xterm } from '@zenfs/linux'
import { Buffer } from 'node:buffer'
import 'fake-indexeddb/auto'

// The Node project runs the kernel tests on real Node, with no DOM (see `vitest.node.config.ts`): this is the part of
// `setup.ts` that does not need one. A test that needs a page (`document`, `window`, a mounted terminal) does not
// belong in this project and is listed in the config's exclusions.
;(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer

// The browser host reads `localStorage` and `sessionStorage`; a Node process has neither, so tests that boot the
// default
// kernel get memory ones, as a fresh browser profile would.
class MemoryStorage implements Storage {
  private _map = new Map<string, string>()
  get length() { return this._map.size }
  clear() { this._map.clear() }
  getItem(key: string) { return this._map.get(key) ?? null }
  key(index: number) { return [...this._map.keys()][index] ?? null }
  removeItem(key: string) { this._map.delete(key) }
  setItem(key: string, value: string) { this._map.set(key, String(value)) }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true, writable: true })
}

// Tests mount the terminal into a page element, and a Node host has no page: it gives the terminal its tty with
// `attach_xterm`, which is all `mount` does that the kernel needs. The config rewrites those `document` calls to
// `globalThis.__page`, a stand-in (a global `document` would send the kernel down its browser paths). Tests that need
// a real page are excluded by the config.
{
  const element = (): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      style: {}, children: [] as unknown[],
      appendChild: (child: unknown) => child, removeChild: (child: unknown) => child, remove() {},
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 })
    }
    return node
  }
  const { Terminal } = await import('#terminal.ts')
  const { TerminalEvents } = await import('@ecmaos/types')
  Object.defineProperty(globalThis, '__page', { value: { createElement: element, body: element() }, configurable: true, writable: true })
  Terminal.prototype.mount = function (this: InstanceType<typeof Terminal> & { _zfsTty?: unknown, _tty: number }, element: HTMLElement) {
    this._zfsTty ??= attach_xterm(this as never, { index: this._tty, input: false })
    ;(this as unknown as { events: { dispatch(name: string, data: unknown): void } }).events.dispatch(TerminalEvents.MOUNT, { terminal: this, element })
  } as typeof Terminal.prototype.mount
}

afterAll(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    console[method] = () => {}
  }
})

// The prebuilt programs are served from disk, as `setup.ts` does (the same catalog the site serves)
{
  const nodeFs = process.getBuiltinModule('node:fs')
  const nodePath = process.getBuiltinModule('node:path')
  const packages = [['coreutils', '../../utils'], ['coreutils-copyleft', '../../utils-copyleft']].map(([name, dir]) => {
    const programs = nodePath.resolve(import.meta.dirname, dir!, 'programs')
    return { name: name!, programs, manifest: JSON.parse(nodeFs.readFileSync(nodePath.join(programs, 'manifest.json'), 'utf8')) }
  })
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const pathname = new URL(raw, 'http://localhost/').pathname
    if (!pathname.startsWith('/programs/')) return realFetch(input as RequestInfo, init)
    if (pathname === '/programs/index.json') {
      const catalog = { packages: packages.map(pkg => ({ name: pkg.manifest.package, path: pkg.name, programs: pkg.manifest.programs })) }
      return Promise.resolve(new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }))
    }
    const [, , pkgName, file] = pathname.split('/')
    const pkg = packages.find(candidate => candidate.name === pkgName)
    const path = pkg && nodePath.join(pkg.programs, nodePath.basename(file ?? ''))
    if (!path || !nodeFs.existsSync(path)) return Promise.resolve(new Response('Not found', { status: 404 }))
    return Promise.resolve(new Response(nodeFs.readFileSync(path), { headers: { 'content-type': 'application/wasm' } }))
  }) as typeof fetch
}
