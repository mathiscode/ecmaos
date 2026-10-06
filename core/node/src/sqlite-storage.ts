import type { DatabaseSync } from 'node:sqlite'

/** A `localStorage`-shaped store in the machine's database, so the kernel's stamps and settings live and die with the root. */
export class SqliteStorage implements Storage {
  constructor(private readonly db: DatabaseSync) {}

  get length() { return (this.db.prepare('SELECT COUNT(*) AS n FROM kv').get() as { n: number }).n }
  clear() { this.db.exec('DELETE FROM kv') }
  getItem(key: string) { return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(String(key)) as { value: string } | undefined)?.value ?? null }
  key(index: number) { return (this.db.prepare('SELECT key FROM kv ORDER BY rowid LIMIT 1 OFFSET ?').get(index) as { key: string } | undefined)?.key ?? null }
  removeItem(key: string) { this.db.prepare('DELETE FROM kv WHERE key = ?').run(String(key)) }
  setItem(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(String(key), String(value)) }
}
