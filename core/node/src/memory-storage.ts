/** A `localStorage`-shaped store that lives in memory. Replaced by a file-backed one once the data directory exists. */
export class MemoryStorage implements Storage {
  private _map = new Map<string, string>()

  get length() { return this._map.size }
  clear() { this._map.clear() }
  getItem(key: string) { return this._map.get(key) ?? null }
  key(index: number) { return [...this._map.keys()][index] ?? null }
  removeItem(key: string) { this._map.delete(key) }
  setItem(key: string, value: string) { this._map.set(key, String(value)) }
}
