/**
 * The stand-in IndexedDB keeps every transaction a database ever ran, and each new one filters the whole list (and its
 * undo log keeps the old data alive), so a test file that runs many commands slows down with every command and grows by
 * hundreds of megabytes. A finished transaction is of no use to anyone, so each new one drops them first.
 */

type RawDatabase = { transactions: Array<{ _state: string }> }
type Database = { _rawDatabase: RawDatabase, transaction: (...args: unknown[]) => unknown }

const prototype = (globalThis as unknown as { IDBDatabase?: { prototype: Database } }).IDBDatabase?.prototype
if (prototype) {
  const transaction = prototype.transaction
  prototype.transaction = function (this: Database, ...args: unknown[]) {
    const raw = this._rawDatabase
    raw.transactions = raw.transactions.filter(entry => entry._state !== 'finished')
    return transaction.apply(this, args)
  }
}
