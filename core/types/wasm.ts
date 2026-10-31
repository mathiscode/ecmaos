/**
 * WebAssembly management types and interfaces
 */

import type { Kernel, Shell } from './index.ts'

/**
 * Options for configuring WebAssembly management
 */
export interface WasmOptions {
  /** Reference to kernel instance */
  kernel: Kernel
}

/**
 * Stream options for WASI component loading
 */
export interface WasiStreamOptions {
  /** Standard input stream */
  stdin: ReadableStream<Uint8Array>
  /** Standard output stream */
  stdout: WritableStream<Uint8Array>
  /** Standard error stream */
  stderr: WritableStream<Uint8Array>
}

/**
 * Result of loading a WASI component
 */
export interface WasiComponentResult {
  /** WebAssembly instance */
  instance: WebAssembly.Instance
  /** Promise that resolves to the exit code */
  exitCode: Promise<number>
}

/**
 * Interface for WebAssembly management functionality
 */
export interface Wasm {
  /**
   * Whether a module runs as a worker-hosted Process under `/bin/wali`: any core module (WALI, wasip1, emcc, or one with no
   * WASI imports at all). A Preview 2 component is not one yet; it still runs on the main thread.
   */
  canRunInWorker(wasmBytes: Uint8Array): Promise<boolean>

  /**
   * `canRunInWorker`, and for a WALI module also what its worker would otherwise work out for itself: the module compiled,
   * and the limits of the memory it imports.
   */
  inspectForWorker(wasmBytes: Uint8Array): Promise<{ inWorker: boolean, wali?: { module: WebAssembly.Module, limits?: { initial: number, maximum: number } } }>

  /**
   * Loads a Preview 2 component with stream integration.
   * @param path - path to the WASM file
   * @param streams - stdin/stdout/stderr stream options
   * @param args - command line arguments
   * @param shell - shell for environment variables
   * @returns the WASM instance and exit code promise
   */
  loadWasiComponent(path: string, streams: WasiStreamOptions, args?: string[], shell?: Shell): Promise<WasiComponentResult>
}
