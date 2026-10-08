import type { KernelContext, StorageOptions, StorageProvider } from '@ecmaos/types'

export class Storage implements StorageProvider {
  private _db: IDBDatabase | null = null
  private _ctx: KernelContext

  get db() { return this._db }

  indexed: IDBFactory | undefined
  /** Whether the browser promised not to evict this origin's storage: `undefined` until it has answered (or when it cannot say) */
  persisted: boolean | undefined
  local: typeof globalThis.localStorage
  session: typeof globalThis.sessionStorage

  constructor(options: StorageOptions) {
    this._ctx = options.context
    this.indexed = options.host ? options.host.storage.indexed : globalThis.indexedDB
    this.local = options.host ? options.host.storage.local : globalThis.localStorage
    this.session = options.host ? options.host.storage.session : globalThis.sessionStorage

    // Asked for at boot; the answer matters because a browser may otherwise evict the whole machine under storage pressure
    void globalThis.navigator?.storage?.persist?.()?.then(granted => {
      this.persisted = granted
      this._ctx.log.debug(granted ? 'Storage is persistent' : 'Storage is best-effort: the browser may clear it when space runs low')
    }, () => {})

    if (this.indexed) {
      const name = options.indexed?.name || 'ecmaos:storage'
      const open = this.indexed.open(name, options.indexed?.version || 1)

      open.onsuccess = () => {
        this._db = open.result
        this._ctx.log.silly(`IndexedDB connection to ${name} successful`)
      }

      open.onerror = () => {
        this._ctx.log.error('IndexedDB connection failed')
      }

      open.onupgradeneeded = (event) => {
        const db = open.result
        db.onerror = event => this._ctx.log.error('IndexedDB connection failed', event)
        const store = db.createObjectStore('ecmaos:storage', { keyPath: 'id', autoIncrement: true })

        switch (event.newVersion) {
          case 1:
            store.createIndex('data', 'data', { unique: false })
            break
        }

        this._ctx.log.silly(`IndexedDB schema ${event.newVersion === 1 ? 'created' : 'updated to version ${event.newVersion}'}`)
      }
    }
  }

  async usage() {
    try {
      const usage = await globalThis.navigator?.storage?.estimate?.()
      if (!usage) throw new Error('Storage usage not available')
      return usage
    } catch (error) {
      this._ctx.log.error('Storage usage failed', error)
      return null
    }
  }
}
