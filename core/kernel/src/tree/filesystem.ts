/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Filesystem class provides a virtual filesystem for the ecmaOS kernel.
 * 
 * @see {@link https://github.com/zen-fs/core ZenFS}
 *
 */

import { TFunction } from 'i18next'
import { _version as zenfsCoreVersion, configure as configureZenFS, fs, InMemory, mounts } from '@zenfs/core'
import { IndexedDB, IndexedDBStore, IndexedDBTransaction } from '@zenfs/dom'
import { StoreFS } from '@zenfs/core'
import { VNode } from '@zenfs/core/vfs/vnode.js'

import { checkFileSize, meterChange, meterStart } from '#lib/storage-limits.ts'
import { chargeQuota } from '#lib/quota.ts'
import { DevTmpFS, ProcFS, SysFS } from '@zenfs/linux'
import { proc_root } from '@zenfs/linux/fs/procfs'
import { init_uts } from '@zenfs/linux/uts'
import { TarReader } from '@gera2ld/tarjs'
import pako from 'pako'
import path from 'path'
import binNodeSource from 'virtual:bin-node'
import binWaliSource from 'virtual:bin-wali'

import type { ConfigMounts, Configuration } from '@zenfs/core'

import type {
  FilesystemConfigMounts,
  FilesystemOptions,
  StorageProvider
} from '@ecmaos/types'

/**
 * Works around a `@zenfs/dom` 1.2.14 / `@zenfs/core` 2.7.6 mismatch that made every positional read on an IndexedDB-backed
 * filesystem (the root, so `/bin`) return zeros for any offset above 0.
 *
 * `StoreFS.read`/`readSync` slice what the transaction hands back with `subarray(offset, end)` unless the store declares the
 * `partial` flag, meaning "the transaction already sliced". The IndexedDB backend's `getSync(id, offset, end)` slices anyway, so
 * the sync path sliced twice (a 64-byte read at offset 1000 became an empty second slice). The fix is for the transaction to
 * return the whole record and leave the slicing to `StoreFS`.
 *
 * Declaring `partial` instead (which an earlier version of this patch did) is wrong: it also tells `StoreFS` that the store
 * honours `set(id, chunk, offset)`, and this backend's `set(id, data)` ignores the offset, so every write that was not a whole
 * replacement (an append, a handle write into an existing file, a database page) replaced the file's whole record with the chunk,
 * on disk and in the cache. Without the flag `StoreFS` merges the chunk into the whole record itself.
 * Remove this once `@zenfs/dom` is consistent about it.
 */
IndexedDBTransaction.prototype.getSync = function (this: IndexedDBTransaction, id: number) {
  const record = this.store.cache.get(id)
  return record ? new Uint8Array(record) : undefined
} as typeof IndexedDBTransaction.prototype.getSync

/**
 * Two guards on writes to the IndexedDB root, for one machine per tab (see `lib/machine-lock.ts`).
 *
 * `fenceRootStore` makes every later write to any IndexedDB store a no-op: a tab whose machine was taken by another tab must not
 * put its stale copy back. Reads still answer from the cache. `rootWritesSettled` resolves once the writes already started have
 * reached IndexedDB (they are issued in the background, one transaction each), so a reboot does not cut the last ones off.
 */
let fenced = false
let pendingWrites = 0
const settleWaiters: Array<() => void> = []

/** The IndexedDB store the root filesystem lives in, or `undefined` when the root is something else (memory, OPFS, ...) */
export function rootStoreName(options: { mounts?: Record<string, unknown> }): string | undefined {
  const root = options.mounts?.['/'] as { backend?: unknown, storeName?: string } | undefined
  if (!root || root.backend !== IndexedDB) return undefined
  return root.storeName ?? 'zenfs'
}

/** `options` with the IndexedDB root pointed at `store`; any other root (an embedder's own) is returned as it was */
export function withRootStore<T extends { mounts?: Record<string, unknown> }>(options: T, store: string): T {
  if (!rootStoreName(options)) return options
  return { ...options, mounts: { ...options.mounts, '/': { ...(options.mounts!['/'] as object), storeName: store } } }
}

/** `options` with the root held in memory instead of whatever it was: a guest session keeps nothing */
export function withMemoryRoot<T extends { mounts?: Record<string, unknown> }>(options: T): T {
  return { ...options, mounts: { ...options.mounts, '/': { backend: InMemory, options: { name: 'guest' } } } }
}

export function fenceRootStore(): void { fenced = true }
export function rootStoreFenced(): boolean { return fenced }

/**
 * Writes of large records are put off briefly and merged. A file is one record, so every change to it clones and rewrites all of it
 * (about 7 ms of main-thread stall per MB), and a program that appends in small pieces to a big file (a log, a database) paid that
 * for each piece. A record of `DeferBytes` or more is now updated in memory at once, as before, and written to IndexedDB once after
 * `DeferMs`, whatever number of changes it took; reads see the in-memory copy, so nothing observable changes except that a crash in
 * that window loses the last changes to a large file (a crash during the old write lost the same). Small records are written at once.
 * `rootWritesSettled` (reboot, halt, a takeover) flushes them first.
 */
export const DeferBytes = 256 * 1024
export const DeferMs = 100
const deferred = new Map<IndexedDBStore, Set<number>>()
let deferTimer: ReturnType<typeof setTimeout> | undefined

const settleIfIdle = () => { if (pendingWrites === 0) for (const waiter of settleWaiters.splice(0)) waiter() }

/** Writes every deferred record to IndexedDB now, one transaction per store */
export async function flushDeferredWrites(): Promise<void> {
  if (deferTimer) { clearTimeout(deferTimer); deferTimer = undefined }
  const work = [...deferred]
  deferred.clear()
  await Promise.all(work.map(async ([store, ids]) => {
    try {
      if (!fenced) {
        const tx = (store as unknown as { db: IDBDatabase }).db.transaction(store.name, 'readwrite')
        const objects = tx.objectStore(store.name)
        for (const id of ids) {
          const data = store.cache.get(id)
          if (data) objects.put(data, id)
        }
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
      }
    } catch (error) {
      globalThis.console?.error?.(`ecmaos: writing ${ids.size} deferred record(s) to IndexedDB failed:`, error)
    } finally {
      pendingWrites -= ids.size
      settleIfIdle()
    }
  }))
}

export function rootWritesSettled(timeoutMs = 2000): Promise<void> {
  if (deferred.size > 0) void flushDeferredWrites()
  if (pendingWrites === 0) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { const at = settleWaiters.indexOf(done); if (at !== -1) settleWaiters.splice(at, 1); resolve() }, timeoutMs)
    settleWaiters.push(done)
  })
}

function tracked<Args extends [number, ...unknown[]]>(original: (this: IndexedDBTransaction, ...args: Args) => Promise<void>) {
  return async function (this: IndexedDBTransaction, ...args: Args): Promise<void> {
    if (fenced) return
    const cache = this.store.cache as Map<number, Uint8Array>
    meterStart({ cache })
    const before = cache.get(args[0])?.byteLength ?? 0
    pendingWrites++
    try { await original.apply(this, args) } finally {
      meterChange({ cache }, (cache.get(args[0])?.byteLength ?? 0) - before)
      if (--pendingWrites === 0) for (const waiter of settleWaiters.splice(0)) waiter()
    }
  }
}

const immediateSet = tracked(IndexedDBTransaction.prototype.set)
const immediateRemove = tracked(IndexedDBTransaction.prototype.remove)
const storedGet = IndexedDBTransaction.prototype.get

IndexedDBTransaction.prototype.set = async function (this: IndexedDBTransaction, id: number, data: Uint8Array): Promise<void> {
  if (fenced) return
  const store = this.store
  const waiting = deferred.get(store)
  if (data.byteLength < DeferBytes && !waiting?.has(id)) return immediateSet.call(this, id, data)
  const cache = store.cache as Map<number, Uint8Array>
  meterStart({ cache })
  const before = cache.get(id)?.byteLength ?? 0
  cache.set(id, new Uint8Array(data))
  meterChange({ cache }, data.byteLength - before)
  if (!waiting?.has(id)) {
    pendingWrites++
    if (waiting) waiting.add(id)
    else deferred.set(store, new Set([id]))
  }
  deferTimer ??= setTimeout(() => { void flushDeferredWrites() }, DeferMs)
} as typeof IndexedDBTransaction.prototype.set

IndexedDBTransaction.prototype.remove = async function (this: IndexedDBTransaction, id: number): Promise<void> {
  const waiting = deferred.get(this.store)
  if (waiting?.delete(id)) {
    pendingWrites--
    if (waiting.size === 0) deferred.delete(this.store)
    settleIfIdle()
  }
  return immediateRemove.call(this, id)
} as typeof IndexedDBTransaction.prototype.remove

// a record whose newest bytes are not in IndexedDB yet must not be read back from there over the in-memory copy
IndexedDBTransaction.prototype.get = async function (this: IndexedDBTransaction, id: number) {
  if (deferred.get(this.store)?.has(id)) return this.store.cache.get(id)
  return storedGet.call(this, id)
} as typeof IndexedDBTransaction.prototype.get

/**
 * A file bigger than the limit (`lib/storage-limits.ts`) is refused with `EFBIG` before anything is written, on the IndexedDB root
 * and any other IndexedDB mount: every write into a file, and a truncate that would make one bigger. Other stores are untouched.
 *
 * It has to be refused where the write enters the file's in-memory copy (`VNode`): by the time it reaches the store, at `close`, the
 * copy has already grown and stays dirty, so the same refusal would come back from every later `close`, even of a read. The check on
 * the store itself is only the backstop for writes that do not go through a file.
 */
type StoreFSLike = { store: unknown }
const limited = <Fn extends (this: StoreFSLike, ...args: never[]) => unknown>(original: Fn, size: (...args: Parameters<Fn>) => number | undefined) =>
  function (this: StoreFSLike, ...args: Parameters<Fn>) {
    if (this.store instanceof IndexedDBStore) {
      const bytes = size(...args)
      if (bytes !== undefined) checkFileSize(bytes, String(args[0]))
    }
    return original.apply(this, args)
  } as unknown as Fn
const proto = StoreFS.prototype as unknown as Record<string, (this: StoreFSLike, ...args: never[]) => unknown>
for (const name of ['write', 'writeSync']) {
  proto[name] = limited(proto[name]!, ((_path: string, data: Uint8Array, offset: number) => offset + data.byteLength) as never)
}
for (const name of ['touch', 'touchSync']) {
  proto[name] = limited(proto[name]!, ((_path: string, metadata: { size?: number }) => metadata.size) as never)
}

/**
 * What `uid` owns on the root: the sizes of its regular files (hard links once), walking the root's own tree and not the other
 * mounts. Synchronous, because it runs inside a write that is about to cross a quota.
 */
export function measureOwnedBytes(uid: number): number {
  const elsewhere = new Set([...mounts.keys()].filter(path => path !== '/'))
  const seen = new Set<number>()
  let total = 0
  const walk = (directory: string) => {
    let names: string[]
    try { names = fs.readdirSync(directory) } catch { return }
    for (const name of names) {
      const path = directory === '/' ? `/${name}` : `${directory}/${name}`
      if (elsewhere.has(path)) continue
      let info
      try { info = fs.lstatSync(path) } catch { continue }
      if (info.isDirectory()) walk(path)
      else if (info.isFile() && info.uid === uid && !seen.has(info.ino)) { seen.add(info.ino); total += info.size }
    }
  }
  walk('/')
  return total
}

export const DefaultFilesystemOptions: Configuration<ConfigMounts> = {
  uid: 0,
  gid: 0,
  // /dev is DevTmpFS, mounted explicitly below; @zenfs/core's legacy DeviceFS is not used
  addDevices: false,
  defaultDirectories: true,
  disableAccessChecks: false,
  disableAsyncCache: false,
  onlySyncOnClose: false,
  log: {
    level: 'debug',
    enabled: false
  },
  mounts: {
    // Options go beside `backend`, not under `options`: zenfs hands the whole object to the backend. The name is the database
    // every existing machine already has (it is what the backend defaults to), so it must not change.
    '/': { backend: IndexedDB, storeName: 'zenfs' } as unknown as ConfigMounts[string],
    '/dev': new DevTmpFS(),
    '/media': { backend: InMemory, options: { name: 'media' } },
    '/mnt': { backend: InMemory, options: { name: 'mnt' } },
    '/proc': new ProcFS(),
    '/sys': new SysFS(),
    '/tmp': { backend: InMemory, options: { name: 'tmpfs' } }
  },
}

/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Filesystem class provides a virtual filesystem for the ecmaOS kernel.
 * 
 * @see {@link https://github.com/zen-fs/core ZenFS}
 *
 */
/** The links Linux puts in `/dev` for the calling process's own descriptors. */
export const DevLinks: Record<string, string> = {
  '/dev/fd': '/proc/self/fd',
  '/dev/stdin': '/proc/self/fd/0',
  '/dev/stdout': '/proc/self/fd/1',
  '/dev/stderr': '/proc/self/fd/2'
}

export class Filesystem {
  private _config: Configuration<ConfigMounts> = DefaultFilesystemOptions
  private _fs: typeof fs = fs
  private _storage: StorageProvider
  /** Names a `localStorage` key for this machine's store (see `lib/machine.ts`) */
  private _key: (key: string) => string
  private _initfs?: string | false
  private _fetch: (url: string, init?: RequestInit) => Promise<Response>

  /**
   * @param sources `initfs` overrides where the initfs tarball is (`false` installs none); `fetch` is what reads it
   */
  constructor(storage: StorageProvider, sources: { initfs?: string | false, fetch?: (url: string, init?: RequestInit) => Promise<Response>, key?: (key: string) => string } = {}) {
    this._storage = storage
    this._key = sources.key ?? (key => key)
    this._initfs = sources.initfs
    this._fetch = sources.fetch ?? ((url, init) => fetch(url, init))
  }

  /**
   * @returns {FilesystemOptions} The filesystem options.
   */
  get config() { return this._config }

  /**
   * @returns {ZenFS.constants} Constants related to the filesystem.
   */
  get constants() { return this._fs.constants }

  /**
   * @returns The filesystem credentials.
   */
  // get credentials(): Credentials { return credentials }

  /**
   * @returns {DeviceFS} The device filesystem.
   * @remarks Remove or replace this; zenfs.mounts is deprecated.
   */
  // get devfs(): DeviceFS { return this._fs.mounts.get('/dev') as DeviceFS }

  /**
   * @returns {ZenFS.fs.promises} The asynchronous ZenFS filesystem instance.
   */
  get fs() { return this._fs.promises }

  /**
   * @returns {ZenFS.fs} The synchronous ZenFS filesystem instance.
   */
  get fsSync() { return this._fs }

  /**
   * @returns {ZenFS.mounts} The mounted filesystems.
   */
  get mounts(): typeof mounts { return mounts }

  /**
   * Configures the filesystem with the given options.
   * @param {FilesystemOptions} options - The options for the filesystem.
   * @returns {Promise<void>} A promise that resolves when the filesystem is configured.
   */
  async configure(options: Partial<Configuration<ConfigMounts>>) {
    if (!options) return
    this._config = options as Configuration<ConfigMounts>
    await configureZenFS(options)
    this.registerProcEntries()
    await this.installBinNode()
    await this.installBinWali()
    const url = this.initfsUrl()
    if (url) await this.installInitfs(url)
  }

  /**
   * Where the initfs tarball comes from. `ECMAOS_INITFS` overrides it (`none` turns it off); with it unset or blank
   * every build, `vite` dev server included, uses the tarball the published site ships, so a development profile
   * holds what a live one does. Tests boot without one: they build their own filesystem.
   */
  private initfsUrl(): string {
    if (this._initfs === false) return ''
    if (this._initfs) return this._initfs
    const configured = import.meta.env['ECMAOS_INITFS'] as string | undefined
    if (configured === 'none') return ''
    if (configured) return configured
    return import.meta.env['VITEST'] || globalThis.process?.env?.['VITEST'] ? '' : '/initfs.tar.gz'
  }

  /**
   * Unpacks the initfs tarball: all of it into a new filesystem, and, when the tarball has changed since (a new
   * release, or a rebuilt one in development), the system-owned `/usr/share` again. Nothing else is rewritten, as
   * `/etc`, `/root` and `/home` hold what users have edited.
   */
  private async installInitfs(url: string, fetcher: (url: string) => Promise<Response> = target => this._fetch(target)) {
    const fsInitialized = await this._storage.local.getItem(this._key('ecmaos:filesystem:initialized'))
    try {
      const response = await fetcher(url)
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const stamp = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      if (fsInitialized && (await this._storage.local.getItem(this._key('ecmaos:filesystem:initfs'))) === stamp) return
      // The browser will likely automatically decompress the tarball; either way, extractTarball will handle it
      await this.fs.writeFile('/tmp/initfs.tar', bytes)
      await this.extractTarball('/tmp/initfs.tar', '/', 0o644, 0o755, fsInitialized ? name => name.replace(/^\.\//, '').startsWith('usr/share/') : undefined)
      await this.fs.unlink('/tmp/initfs.tar')
      await this._storage.local.setItem(this._key('ecmaos:filesystem:initialized'), 'true')
      await this._storage.local.setItem(this._key('ecmaos:filesystem:initfs'), stamp)
    } catch (error) {
      globalThis.kernel?.log.error(`Failed to fetch ${url}: ${error}`)
      console.error(error)
    }
  }

  /**
   * Writes the real `/bin/node` interpreter -- the worker-hosted body `@zenfs/linux`'s own default
   * `binfmt_js` already points every plain JS/ESM program at via `execve`. Rewritten on every boot
   * so it always matches this build; see `src/bin/node.mjs` for what it actually does and why it
   * ships as one bundle with no import statements.
   */
  private async installBinNode() {
    if (!(await this.fs.exists('/bin'))) await this.fs.mkdir('/bin', { recursive: true })
    await this.fs.writeFile('/bin/node', binNodeSource, { mode: 0o755 })
  }

  /**
   * Writes the real `/bin/wali` interpreter -- the worker-hosted body `@zenfs/linux`'s own default
   * `binfmt_wasm` already points every `.wasm` file at via `execve` (matched on magic bytes alone,
   * with no way to tell WALI-format modules from plain WASI-preview1 ones at that layer -- see
   * `src/bin/wali.mjs`'s doc comment). Rewritten on every boot so it always matches this build.
   */
  private async installBinWali() {
    if (!(await this.fs.exists('/bin'))) await this.fs.mkdir('/bin', { recursive: true })
    await this.fs.writeFile('/bin/wali', binWaliSource, { mode: 0o755 })
  }

  /**
   * Adds ecmaOS's browser-backed entries to ProcFS's `/proc` root.
   *
   * `/proc/version` exists upstream too, but reports `@zenfs/linux`'s own package version as if it
   * were the kernel -- accurate for a real Linux build (`uname -r` genuinely is the kernel's own
   * version), but misleading here, since `@zenfs/linux` is the POSIX layer ecmaOS runs on top of, not
   * ecmaOS itself. Overridden below so ecmaOS's own version is the headline "kernel" version (matching
   * `Kernel.version`, `import.meta.env['VERSION']`), with `@zenfs/linux` (`init_uts.release`) and
   * `@zenfs/core` (its own exported `_version`) kept separately in the parenthetical, same place a
   * real `/proc/version` keeps its compiler/build info. `cpuinfo`
   * and `meminfo` are new here, generated on read from `navigator.*` and `performance.memory`. A field
   * that cannot be populated honestly is omitted rather than zero-filled or fabricated.
   */
  private registerProcEntries() {
    proc_root.children.set('version', {
      mode: 0o444,
      show: () => `ecmaOS version ${import.meta.env['VERSION'] || '?.?.?'} (@zenfs/linux ${init_uts.release}, @zenfs/core ${zenfsCoreVersion})\n`
    })

    proc_root.children.set('cpuinfo', {
      mode: 0o444,
      show: () => {
        const cores = navigator.hardwareConcurrency || 1
        const stanza = (index: number) => [
          `processor\t: ${index}`,
          `vendor_id\t: browser`,
          `model name\t: ${navigator.userAgentData?.platform || navigator.platform || navigator.userAgent}`,
          ''
        ].join('\n')

        return Array.from({ length: cores }, (_, i) => stanza(i)).join('\n')
      }
    })

    proc_root.children.set('meminfo', {
      mode: 0o444,
      show: () => {
        const lines: string[] = []
        if ('deviceMemory' in navigator && navigator.deviceMemory) {
          const totalKb = Math.round(navigator.deviceMemory * 1024 * 1024)
          lines.push(`MemTotal:       ${totalKb} kB`)
        }

        if (performance.memory) {
          const { totalJSHeapSize, usedJSHeapSize, jsHeapSizeLimit } = performance.memory
          lines.push(`MemFree:        ${Math.round((totalJSHeapSize - usedJSHeapSize) / 1024)} kB`)
          lines.push(`MemAvailable:   ${Math.round((jsHeapSizeLimit - usedJSHeapSize) / 1024)} kB`)
        }

        return lines.length ? lines.join('\n') + '\n' : ''
      }
    })

    proc_root.children.set('userAgent', {
      mode: 0o444,
      show: () => `${navigator.userAgent}\n`
    })

    proc_root.children.set('platform', {
      mode: 0o444,
      show: () => `${navigator.userAgentData?.platform || navigator.platform || 'unknown'}\n`
    })

    proc_root.children.set('connection', {
      mode: 0o444,
      show: () => {
        const connection = (navigator as unknown as { connection?: { effectiveType?: string, downlink?: number, rtt?: number, saveData?: boolean } }).connection
        if (!connection) return ''
        const lines: string[] = []
        if (connection.effectiveType) lines.push(`effectiveType\t: ${connection.effectiveType}`)
        if (connection.downlink !== undefined) lines.push(`downlink\t: ${connection.downlink} Mb/s`)
        if (connection.rtt !== undefined) lines.push(`rtt\t\t: ${connection.rtt} ms`)
        if (connection.saveData !== undefined) lines.push(`saveData\t: ${connection.saveData}`)
        return lines.length ? lines.join('\n') + '\n' : ''
      }
    })
  }

  /**
   * Checks if a file or directory exists at the given path.
   * @param {string} path - The path to check.
   * @returns {Promise<boolean>} A promise that resolves to true if the path exists, false otherwise.
   * 
   * @remarks A shortcut for `kernel.filesystem.fs.exists`
   */
  async exists(path: string) {
    return await this.fs.exists(path)
  }

  /**
   * Recursively copy every file and directory under `source` to `destination`, both already
   * mounted paths within this filesystem (they may be on different backends -- this is plain
   * `@zenfs/core` file I/O, so it works across mount boundaries the same way `cp -r` does).
   *
   * This is the migration primitive for moving a filesystem's contents onto another backend, e.g.
   * an IndexedDB-backed root's contents onto an `opfs`-mounted directory: mount the destination
   * somewhere temporary, `copyTree('/', '/mnt/opfs-migration')`, then repoint `/etc/fstab` at it.
   * There is no automatic root-swap here -- that needs `root=` cmdline parsing, which does not
   * exist until the overhaul's `init` branch adopts `@zenfs/linux`'s `init()`.
   *
   * @returns the number of files copied (directories are not counted)
   */
  async copyTree(source: string, destination: string): Promise<number> {
    const stats = await this.fs.stat(source)
    if (!stats.isDirectory()) {
      // Not `this.fs.copyFile()`: it throws "the 'data' argument must be of type string or an
      // instance of Buffer..." against a mounted (non-root-InMemory) backend in @zenfs/core@2.7.4
      // -- readFile+writeFile is the same work `copyFile` does internally, without the bug.
      // The extra `new Uint8Array(...)` guards against `writeFile`'s `instanceof Uint8Array` check
      // failing across a module-instance boundary (observed under vitest/jsdom) even though the
      // buffer `readFile` returns is structurally a real Buffer.
      const contents = await this.fs.readFile(source)
      await this.fs.writeFile(destination, new Uint8Array(contents))
      return 1
    }

    try {
      await this.fs.mkdir(destination, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    let copied = 0
    for (const entry of await this.fs.readdir(source)) {
      copied += await this.copyTree(path.join(source, entry), path.join(destination, entry))
    }

    return copied
  }

  /**
   * Extracts a tarball to the given path.
   * TODO: Just use the tar coreutil
   * 
   * @param {string} tarballPath - The path to the tarball.
   * @param {string} extractPath - The path to extract the tarball to.
   * @param {number} fileMode - The mode to set for files. Defaults to 0o644.
   * @param {number} directoryMode - The mode to set for directories. Defaults to 0o755.
   * @returns {Promise<void>} A promise that resolves when the tarball is extracted.
   */
  async extractTarball(tarballPath: string, extractPath: string, fileMode: number = 0o644, directoryMode: number = 0o755, filter?: (name: string) => boolean) {
    const tarball = await this.fs.readFile(tarballPath)
    
    // Check if the file is gzipped by looking at the magic bytes
    const isGzipped = tarball.length >= 2 && tarball[0] === 0x1f && tarball[1] === 0x8b
    
    // Only decompress if the file is actually gzipped
    const tarData = isGzipped ? pako.ungzip(tarball) : tarball
    const tar = await TarReader.load(tarData)

    const hasPackageDir = tar.fileInfos.some(file => file.name.startsWith('package/'))
    const stripPrefix = hasPackageDir ? 'package/' : ''

    // Helper function to ensure a directory exists, removing any file that conflicts
    const ensureDirectory = async (dirPath: string) => {
      const normalizedPath = path.normalize(dirPath)
      
      // Check if path exists and what type it is
      if (await this.fs.exists(normalizedPath)) {
        try {
          const stat = await this.fs.stat(normalizedPath)
          if (stat.isFile()) {
            // A file exists where we need a directory - remove it
            await this.fs.unlink(normalizedPath)
          } else if (stat.isDirectory()) {
            // Directory already exists, nothing to do
            return
          }
        } catch {
          // If stat fails, try to proceed with mkdir anyway
        }
      }
      
      // Create the directory (recursive will create parent dirs if needed)
      try {
        await this.fs.mkdir(normalizedPath, { mode: directoryMode, recursive: true })
      } catch (mkdirError: unknown) {
        // If mkdir fails with ENOTDIR, it means a parent path is a file, not a directory
        // Recursively check and fix parent directories
        const error = mkdirError as { code?: string; message?: string }
        if (error?.code === 'ENOTDIR' || error?.message?.includes('ENOTDIR')) {
          const parent = path.dirname(normalizedPath)
          if (parent !== normalizedPath && parent !== '.' && parent !== '/') {
            // Recursively ensure parent directory exists
            await ensureDirectory(parent)
            // Retry creating the directory
            await this.fs.mkdir(normalizedPath, { mode: directoryMode, recursive: true })
          } else {
            throw mkdirError
          }
        } else {
          throw mkdirError
        }
      }
    }

    for (const file of tar.fileInfos) {
      // Skip GNU tar @LongLink entries (used for paths > 100 characters)
      // These are metadata entries, not actual files
      if (file.name === '@LongLink' || file.name === './@LongLink' || file.name.endsWith('/@LongLink')) continue

      if (hasPackageDir && !file.name.startsWith(stripPrefix)) continue

      const relativePath = hasPackageDir ? file.name.slice(stripPrefix.length) : file.name
      if (!relativePath) continue
      if (filter && !filter(relativePath)) continue

      try {
        if (relativePath.endsWith('/')) {
          await ensureDirectory(path.join(extractPath, relativePath))
          continue
        }

        await ensureDirectory(path.join(extractPath, path.dirname(relativePath)))

        const blob = tar.getFileBlob(file.name)
        if (!blob) {
          // Skip files that can't be extracted (e.g., hard links, symlinks, or empty files)
          continue
        }

        try {
          // a Blob without arrayBuffer() (jsdom's) is read the older way
          const binaryData = new Uint8Array(await (typeof blob.arrayBuffer === 'function'
            ? blob.arrayBuffer()
            : new Promise<ArrayBuffer>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(reader.result as ArrayBuffer)
              reader.onerror = () => reject(reader.error)
              reader.readAsArrayBuffer(blob as Blob)
            })))
          const filePath = path.join(extractPath, relativePath)
          await this.fs.writeFile(filePath, binaryData, { encoding: 'binary', mode: fileMode })
        } catch (extractError) {
          // If we can't extract the file content, skip it rather than failing the entire extraction
          globalThis.kernel?.terminal.writeln(`Failed to extract file ${file.name}: ${extractError instanceof Error ? extractError.message : String(extractError)}`)
          continue
        }
      } catch (error) {
        globalThis.kernel?.terminal.writeln(`Failed to extract file ${file.name}: ${error}`)
      }
    }
  }

  /**
   * Returns the default filesystem options with the given extensions.
   * @param {Partial<FilesystemOptions>} extensions - The extensions to apply to the default options.
   * @returns {FilesystemOptions} The filesystem options with the given extensions.
   *
   */
  static options<T extends FilesystemConfigMounts>(extensions?: Partial<FilesystemOptions<T>>): FilesystemOptions<T> {
    return {
      ...DefaultFilesystemOptions,
      ...(extensions || {})
    } as FilesystemOptions<T>
  }

  // Descriptions for common filesystem entries
  descriptions = (t?: TFunction | ((key: string) => string)) => {
    if (!t) t = (k: string) => { return k }

    return new Map([
      ['/bin', t('User Programs')],
      ['/boot', t('Boot files')],
      ['/dev', t('Device files')],
      ['/etc', t('Configuration files')],
      ['/home', t('User home directories')],
      ['/lib', t('Library files')],
      ['/mnt', t('Temporary mount point')],
      ['/opt', t('Optional applications')],
      ['/proc', t('Process/system information')],
      ['/root', t('Root user home directory')],
      ['/run', t('Runtime data')],
      ['/sbin', t('System programs')],
      ['/sys', t('System files')],
      ['/tmp', t('Temporary files')],
      ['/usr', t('User data')],
      ['/var', t('Variable data')],

      ['/dev/fd', t('Open file descriptors of this process')],
      ['/dev/stdin', t('Standard input')],
      ['/dev/stdout', t('Standard output')],
      ['/dev/stderr', t('Standard error')],

      ['/proc/connection', t('Network Connection Data')],
      ['/proc/cpuinfo', t('Processor Information')],
      ['/proc/meminfo', t('Memory Information')],
      ['/proc/platform', t('Platform Information')],
      ['/proc/self', t('This process')],
      ['/proc/userAgent', t('User Agent')],
      ['/proc/version', t('Kernel Version')],

      ['.bin', t('Binary File')],
      ['.bmp', t('Bitmap Image')],
      ['.c', t('C Source File')],
      ['.cpp', t('C++ Source File')],
      ['.css', t('CSS Stylesheet')],
      ['.csv', t('CSV Data')],
      ['.gif', t('GIF Image')],
      ['.gz', t('GZIP Archive')],
      ['.h', t('C Header File')],
      ['.hpp', t('C++ Header File')],
      ['.html', t('HTML Document')],
      ['.ico', t('Icon Image')],
      ['.java', t('Java Source File')],
      ['.jpg', t('JPEG Image')],
      ['.jpeg', t('JPEG Image')],
      ['.js', t('JavaScript File')],
      ['.json', t('JSON Data')],
      ['.jsonc', t('JSONC Data')],
      ['.jsonl', t('JSONL Data')],
      ['.jsx', t('JSX Source File')],
      ['.log', t('Log File')],
      ['.lua', t('Lua Script')],
      ['.md', t('Markdown Document')],
      ['.pdf', t('PDF Document')],
      ['.php', t('PHP Script')],
      ['.png', t('PNG Image')],
      ['.py', t('Python Script')],
      ['.rb', t('Ruby Script')],
      ['.rs', t('Rust Source File')],
      ['.scala', t('Scala Source File')],
      ['.sh', t('Shell Script')],
      ['.sixel', t('Sixel Graphics')],
      ['.svg', t('SVG Image')],
      ['.swift', t('Swift Source File')],
      ['.tar', t('TAR Archive')],
      ['.tar.bz2', t('TAR Archive (BZIP2)')],
      ['.tar.gz', t('TAR Archive (GZIP)')],
      ['.tar.xz', t('TAR Archive (XZ)')],
      ['.ts', t('TypeScript File')],
      ['.tsx', t('TypeScript React File')],
      ['.txt', t('Text File')],
      ['.vue', t('Vue.js Component')],
      ['.wasm', t('WebAssembly Module')],
      ['.wat', t('WebAssembly Text Format')],
      ['.webm', t('WebM Video')],
      ['.webp', t('WebP Image')],
      ['.xml', t('XML Document')],
      ['.yaml', t('YAML Data')],
      ['.yml', t('YAML Data')],
      ['.zip', t('ZIP Archive')],
    ])
  }
}

type NodeLike = { fs: StoreFSLike, path: string }
const nodeProto = VNode.prototype as unknown as Record<string, (this: NodeLike, ...args: never[]) => unknown>
const limitedNode = (original: (this: NodeLike, ...args: never[]) => unknown, size: (...args: never[]) => number) =>
  function (this: NodeLike, ...args: never[]) {
    if (this.fs.store instanceof IndexedDBStore) {
      const end = size(...args)
      checkFileSize(end, this.path)
      chargeQuota((this as unknown as { inode: { uid: number, size: number } }).inode, end, this.path)
    }
    return original.apply(this, args)
  }
for (const name of ['write', 'writeSync']) nodeProto[name] = limitedNode(nodeProto[name]!, ((data: Uint8Array, offset: number) => offset + data.byteLength) as never)
nodeProto['truncate'] = limitedNode(nodeProto['truncate']!, ((length: number) => length) as never)
