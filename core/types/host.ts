/**
 * The environment the kernel runs in. Everything the kernel needs from "the page" (storage, the platform's
 * hostname, notifications, restart, and the defaults for the options a caller did not give) is read through
 * this interface, so the same kernel can run in a browser or in a Node process.
 */

import type { KernelOptions } from './kernel.ts'

/** Desktop-style notifications; absent on hosts that have none. */
export interface HostNotifications {
  /** `default` means the user has not been asked yet */
  permission(): NotificationPermission
  request(): Promise<unknown>
  /** Shows a notification, asking for permission first when it is still `default` */
  send(title: string, options?: NotificationOptions): Promise<void | Notification>
}

export interface HostPlatform {
  /** The name this machine reports in `/etc/hostname` on first boot */
  hostname(): string
  /** Starts the system again after a shutdown (a page reload in a browser) */
  restart(): void | Promise<void>
  /** Ends the host after `halt` or `poweroff`, once the kernel has shut down (a Node process exits; a page has nothing to do) */
  exit?(mode: 'halt' | 'poweroff'): void | Promise<void>
  notifications?: HostNotifications
}

export interface HostStorage {
  /** `localStorage`-shaped: also holds the filesystem stamps and per-user settings */
  local: Storage
  session: Storage
  /** Absent when the host has no IndexedDB; the kernel then skips opening its database */
  indexed?: IDBFactory
}

export interface Host {
  readonly kind: 'browser' | 'node'
  readonly storage: HostStorage
  readonly platform: HostPlatform
  /** How many terminals the machine has of its own to log in on, from TTY 0 (eight when absent); a Node host has only the console */
  readonly terminals?: number
  /** Fetches the initfs and the program catalog; the global `fetch` when absent. A Node host serves its bundled files here. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /**
   * Web Locks (`navigator.locks`) or something shaped like it. When present, the kernel takes a lock named for its IndexedDB root
   * before loading it, so two tabs never run one machine at once. Absent (a Node host, tests, an embedder with its own root): no guard.
   */
  readonly locks?: LockManager
  /** Which machine to run on this host's storage, by name (a browser page: `?machine=NAME`); absent or `root` is the default machine */
  readonly machine?: string
  /** Fills the kernel options a caller left out (root mount, devices, DOM, service worker); a caller's own options win */
  readonly defaults?: Partial<KernelOptions>
}
