/** `async_hooks`: `AsyncLocalStorage` that holds its store for the synchronous extent of `run` (no async propagation) */
class AsyncLocalStorage {
  #store
  run(store, callback, ...args) { const previous = this.#store; this.#store = store; try { return callback(...args) } finally { this.#store = previous } }
  getStore() { return this.#store }
  enterWith(store) { this.#store = store }
  exit(callback, ...args) { return this.run(undefined, callback, ...args) }
  disable() { this.#store = undefined }
}
class AsyncResource {
  constructor(type) { this.type = type }
  runInAsyncScope(callback, thisArg, ...args) { return Reflect.apply(callback, thisArg, args) }
  emitDestroy() { return this }
  asyncId() { return 1 }
  triggerAsyncId() { return 0 }
  static bind(callback) { return callback }
  bind(callback) { return callback }
}
module.exports = { AsyncLocalStorage, AsyncResource, createHook: () => ({ enable() { return this }, disable() { return this } }), executionAsyncId: () => 1, triggerAsyncId: () => 0 }
