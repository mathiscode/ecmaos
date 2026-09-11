/**
 * Storage types and interfaces
 */

import type { KernelContext } from './kernel.ts'

/**
 * Options for configuring storage
 */
export interface StorageOptions {
  /** The cross-cutting kernel primitives (log is the only one Storage uses) */
  context: KernelContext
  /** IndexedDB configuration */
  indexed?: {
    /** Database name */
    name: string
    /** Database version */
    version: number
  }
}

/**
 * Interface for storage functionality
 */
export interface StorageProvider {
  /** Get the IndexedDB database instance */
  readonly db: IDBDatabase | null

  /** IndexedDB interface */
  readonly indexed: IDBFactory
  /** LocalStorage interface */
  readonly local: Storage
  /** SessionStorage interface */
  readonly session: Storage

  /** Get storage usage */
  usage(): Promise<StorageEstimate | null>
} 