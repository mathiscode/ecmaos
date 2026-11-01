/**
 * WebAssembly management types and interfaces
 */

import type { Kernel } from './index.ts'

/**
 * Options for configuring WebAssembly management
 */
export interface WasmOptions {
  /** Reference to kernel instance */
  kernel: Kernel
}

/**
 * What the kernel prepares for the worker that will run a program (sent ahead of its `init`): a core module compiled
 * and the limits of the memory it imports, or a Preview 2 component transpiled by jco.
 */
export interface WasmProgram {
  /** A core module, compiled */
  module?: WebAssembly.Module
  /** A component as jco generated it: the JavaScript that joins its core modules, and those modules by name */
  component?: { js: string, modules: Record<string, WebAssembly.Module>, exports: string[], imports: string[] }
  /** The limits of the memory a WALI module imports, in pages */
  limits?: { initial: number, maximum: number }
  /** The file it was prepared from (inode, size, mtime): a worker whose program is another file reads that one */
  id?: string
}

/**
 * Interface for WebAssembly management functionality
 */
export interface Wasm {
  /**
   * Whether a program runs as a worker-hosted Process under `/bin/wali`: any core module (WALI, wasip1, emcc, or one with
   * no WASI imports at all) and any Preview 2 component.
   */
  canRunInWorker(wasmBytes: Uint8Array): Promise<boolean>

  /**
   * `canRunInWorker`, and what the worker would otherwise work out for itself: a core module compiled with the limits of
   * the memory it imports (WALI), or a component transpiled.
   */
  inspectForWorker(wasmBytes: Uint8Array): Promise<{ inWorker: boolean, wali?: WasmProgram }>

  /**
   * Transpiles a Preview 2 component with jco, which is too large for the worker's bundle: the worker is sent the
   * generated JavaScript and the compiled core modules.
   */
  prepareComponent(wasmBytes: Uint8Array): Promise<WasmProgram>
}
