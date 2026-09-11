/**
 * Protocol handling types and interfaces
 */

import type { Terminal } from './terminal.ts'

/**
 * Options for configuring protocol handling
 */
export interface ProtocolOptions {
  /** Optional protocol schema */
  schema?: string
}

/**
 * What `Protocol` needs from subsystems that may not exist yet at construction time, delivered
 * once they do via `wire()`.
 */
export interface ProtocolWiring {
  terminal: Terminal
}

/**
 * Interface for protocol handling functionality
 */
export interface Protocol {
  /**
   * Supply the subsystems `Protocol` needs but that don't exist at construction time. Must be
   * called before `open()` is used.
   */
  wire(wiring: ProtocolWiring): void

  /**
   * Open a URI with the protocol handler
   * @param uri - URI to open
   */
  open(uri: string): void
}
