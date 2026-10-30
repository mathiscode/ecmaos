/** `diagnostics_channel`: named channels that publish to their subscribers */
const channels = new Map()
class Channel {
  constructor(name) { this.name = name; this._subscribers = new Set() }
  get hasSubscribers() { return this._subscribers.size > 0 }
  subscribe(listener) { this._subscribers.add(listener) }
  unsubscribe(listener) { return this._subscribers.delete(listener) }
  publish(message) { for (const listener of this._subscribers) listener(message, this.name) }
  bindStore() {}
  unbindStore() {}
  runStores(data, fn, thisArg, ...args) { return Reflect.apply(fn, thisArg, args) }
}
const channel = name => { let found = channels.get(name); if (!found) channels.set(name, found = new Channel(name)); return found }
module.exports = { channel, hasSubscribers: name => channels.get(name)?.hasSubscribers ?? false, subscribe: (name, listener) => channel(name).subscribe(listener), unsubscribe: (name, listener) => channel(name).unsubscribe(listener), Channel, tracingChannel: name => ({ start: channel(`tracing:${name}:start`), end: channel(`tracing:${name}:end`), error: channel(`tracing:${name}:error`), traceSync: (fn, context, thisArg, ...args) => Reflect.apply(fn, thisArg, args) }) }
