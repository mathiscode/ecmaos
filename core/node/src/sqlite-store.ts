import { DatabaseSync } from 'node:sqlite'
import { StoreFS, SyncTransaction } from '@zenfs/core'

import type { Store } from '@zenfs/core'

/** Bump when the layout changes; an older database is upgraded in `open`, a newer one is refused. */
const SchemaVersion = 1

export type Synchronous = 'off' | 'normal' | 'full'

export interface OpenOptions {
  /** How hard a commit is pushed to disk. `normal` (the default) can lose the last moments, never the database. */
  synchronous?: Synchronous
}

/** Opens (creating it if need be) the machine's database, with the layout and settings both the store and the storage need. */
export function openDatabase(file: string, options: OpenOptions = {}): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`PRAGMA synchronous = ${options.synchronous ?? 'normal'}`)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined
  const version = row ? Number(row.value) : 0
  if (version > SchemaVersion) {
    db.close()
    throw new Error(`${file} was written by a newer ecmaOS (schema ${version}, this one reads ${SchemaVersion})`)
  }
  db.exec('CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, data BLOB NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (version < SchemaVersion) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SchemaVersion))
  return db
}

/**
 * A ZenFS store on one SQLite table (`id INTEGER PRIMARY KEY, data BLOB`): the root filesystem of a Node machine. It
 * keeps what a host directory cannot: the guest's owners, modes and symlinks. Each ZenFS transaction is already rolled
 * back by ZenFS itself, so writes go straight to the database; they are batched into one SQLite transaction that is
 * committed at the end of the tick, on `sync()`, and when the process exits.
 */
export class SqliteStore implements Store {
  readonly name = 'sqlitefs'
  readonly flags = [] as const
  private _open = false
  private _timer?: NodeJS.Immediate
  private readonly _get
  private readonly _set
  private readonly _delete
  private readonly _keys

  constructor(readonly db: DatabaseSync, readonly label?: string) {
    this._get = db.prepare('SELECT data FROM blocks WHERE id = ?')
    this._set = db.prepare('INSERT OR REPLACE INTO blocks (id, data) VALUES (?, ?)')
    this._delete = db.prepare('DELETE FROM blocks WHERE id = ?')
    this._keys = db.prepare('SELECT id FROM blocks')
  }

  get(id: number): Uint8Array | undefined {
    const row = this._get.get(id) as { data: Uint8Array } | undefined
    return row ? new Uint8Array(row.data) : undefined
  }

  set(id: number, data: Uint8Array) {
    this.begin()
    this._set.run(id, data)
  }

  delete(id: number) {
    this.begin()
    this._delete.run(id)
  }

  keys(): number[] {
    return (this._keys.all() as { id: number }[]).map(row => row.id)
  }

  transaction() { return new SqliteTransaction(this) }

  async sync() { this.commit() }

  /** Commits what is pending now; safe to call at any time */
  commit() {
    clearImmediate(this._timer)
    this._timer = undefined
    if (!this._open) return
    this._open = false
    this.db.exec('COMMIT')
  }

  private begin() {
    if (!this._open) {
      this.db.exec('BEGIN')
      this._open = true
    }
    this._timer ??= setImmediate(() => this.commit())
  }
}

class SqliteTransaction extends SyncTransaction<SqliteStore> {
  async keys() { return this.store.keys() }
  getSync(id: number) { return this.store.get(id) }
  setSync(id: number, data: Uint8Array) { this.store.set(id, data) }
  removeSync(id: number) { this.store.delete(id) }
}

/** The root filesystem over `db`, ready to mount at `/` */
export function sqliteRoot(db: DatabaseSync): { fs: StoreFS<SqliteStore>, store: SqliteStore } {
  const store = new SqliteStore(db, 'root')
  const fs = new StoreFS(store)
  fs.checkRootSync()
  store.commit()
  return { fs, store }
}
