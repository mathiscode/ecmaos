import type { Events as IEvents, EventCallback } from '@ecmaos/types'

/** Kernel events travel on the page's global target so other page code can observe them; a host with no
 *  global event target (Node) gets a private one. */
const fallbackTarget = new EventTarget()
const bus = (): EventTarget => typeof globalThis.addEventListener === 'function' ? globalThis : fallbackTarget

export class Events implements IEvents {
  private _callbacks: Map<string, EventCallback[]> = new Map()
  private _listeners: Map<string, EventListener> = new Map()

  clear() {
    this._callbacks.clear()
    this._listeners.clear()
  }

  dispatch<T>(event: string, data: T) {
    bus().dispatchEvent(new CustomEvent(event, { detail: data }))
  }

  emit<T>(event: string, data: T) {
    this.dispatch(event, data)
  }

  listen<T>(event: string, callback: EventCallback<T>) {
    this.on(event, callback)
  }

  on<T>(event: string, callback: EventCallback<T>) {
    if (!this._callbacks.has(event)) this._callbacks.set(event, [])
    this._callbacks.get(event)?.push(callback as EventCallback)

    const listener = (e: Event) => {
      if (e instanceof CustomEvent) callback(e.detail)
    }

    this._listeners.set(`${event}-${callback.toString()}`, listener)
    bus().addEventListener(event, listener)
  }

  off<T>(event: string, callback: EventCallback<T>) {
    const callbacks = this._callbacks.get(event)
    if (callbacks) {
      const index = callbacks.indexOf(callback as EventCallback)
      if (index !== -1) {
        callbacks.splice(index, 1)
        if (callbacks.length === 0) this._callbacks.delete(event)

        const listenerKey = `${event}-${callback.toString()}`
        const listener = this._listeners.get(listenerKey)
        if (listener) {
          bus().removeEventListener(event, listener)
          this._listeners.delete(listenerKey)
        }
      }
    }
  }

  unlisten<T>(event: string, callback: EventCallback<T>) {
    this.off(event, callback)
  }
}
