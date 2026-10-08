import type { Host } from '@ecmaos/types'

/**
 * The browser host: storage, platform and notification access come from the page's globals, read when asked
 * (not at import), so importing this module is safe anywhere. It adds no option defaults; the kernel's own
 * defaults are the browser's.
 */
export function browserHost(): Host {
  return {
    kind: 'browser',
    storage: {
      get local() { return globalThis.localStorage },
      get session() { return globalThis.sessionStorage },
      get indexed() { return globalThis.indexedDB }
    },
    get locks() { return globalThis.navigator?.locks },
    platform: {
      hostname: () => globalThis.location?.hostname || '',
      restart: () => globalThis.location.reload(),
      notifications: {
        permission: () => globalThis.Notification?.permission ?? 'denied',
        request: async () => globalThis.Notification?.requestPermission(),
        async send(title, options = {}) {
          if (!globalThis.Notification) return
          if (Notification.permission === 'granted') return new Notification(title, options)
          await Notification.requestPermission()
        }
      }
    }
  }
}
