/**
 * Telemetry handling types and interfaces
 */

import type { KernelContext } from './kernel.ts'

/**
 * Options for configuring telemetry handling
 */
export interface TelemetryOptions {
  /** The cross-cutting kernel primitives (log is the only one telemetry uses) */
  context: KernelContext
}

/**
 * Interface for telemetry handling functionality
 */
export interface Telemetry {
  /** Whether telemetry is currently active */
  readonly active: boolean
}
