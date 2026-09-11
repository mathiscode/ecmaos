/**
 * Service worker types and interfaces
 */

declare global {
  interface BackgroundFetchManager {
    fetch(id: string, urls: string[], options: object): Promise<BackgroundFetchRegistration>
  }

  interface BackgroundFetchRegistration extends EventTarget {
    readonly id: string;
    readonly uploadTotal: number;
    readonly uploaded: number;
    readonly downloadTotal: number;
    readonly downloaded: number;
    readonly result: unknown;
    readonly failureReason: unknown;
  
    match(request: RequestInfo, options?: CacheQueryOptions): Promise<Response | undefined>;
    matchAll(): Promise<Response[]>;
    onprogress: ((this: BackgroundFetchRegistration, ev: ProgressEvent<BackgroundFetchRegistration>) => unknown) | null;
  }
}

import type { KernelContext } from './kernel.ts'
import type { Filesystem } from './filesystem.ts'
import type { Shell } from './shell.ts'
import type { Terminal } from './terminal.ts'

/**
 * Options for configuring the service worker
 */
export interface ServiceOptions {
  /** The cross-cutting kernel primitives (id and log are what Service uses) */
  context: KernelContext
  /** The filesystem, for serving file reads the Service Worker requests */
  filesystem: Filesystem
  /** Path to service worker file */
  path?: string
  /** Whether to register the service worker */
  register?: boolean
}

/**
 * What `Service` needs from subsystems that may not exist yet at construction time, delivered
 * once they do via `wire()`.
 */
export interface ServiceWiring {
  shell: Shell
  terminal: Terminal
}

/**
 * Interface for service worker functionality
 */
export interface Service {
  /**
   * Supply the subsystems `Service` needs but that don't exist at construction time. Must be
   * called before `fetch()` is used (background-fetch completion writes to the shell's cwd and
   * reports to the terminal).
   */
  wire(wiring: ServiceWiring): void

  /** Get background fetches */
  readonly fetches: Record<string, BackgroundFetchRegistration>
  /** Get service options */
  readonly options: ServiceOptions
  /** Get service worker registration */
  readonly registration?: ServiceWorkerRegistration & {
    backgroundFetch: BackgroundFetchManager
  }

  /**
   * Fetch resources in the background
   * @param id - Fetch ID
   * @param urls - URLs to fetch
   * @param options - Fetch options
   */
  fetch(id: string, urls: string[], options: object): Promise<BackgroundFetchRegistration>

  /**
   * Send a message to the service worker
   * @param message - Message to send
   */
  message(message: string): Promise<void>

  /**
   * Register the service worker
   */
  register(): Promise<ServiceWorkerRegistration>

  /**
   * Unregister the service worker
   */
  unregister(): Promise<void>

  /**
   * Update the service worker
   */
  update(): Promise<void>
} 