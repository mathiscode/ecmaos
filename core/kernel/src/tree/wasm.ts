import type { Kernel, WasmOptions, Wasm as IWasm, Shell } from '@ecmaos/types'

import createWasiPreview2Bindings from './wasi/preview2'

export interface WasiStreamOptions {
  stdin: ReadableStream<Uint8Array>
  stdout: WritableStream<Uint8Array>
  stderr: WritableStream<Uint8Array>
}

export interface WasiComponentResult {
  instance: WebAssembly.Instance
  exitCode: Promise<number>
}

/** The limits of the first memory a module imports, as `/bin/wali` reads them (`memoryLimits` in `src/bin/wali.mjs`) */
function memoryImportLimits(bytes: Uint8Array): { initial: number, maximum: number } | undefined {
  let at = 8
  const leb = () => {
    let result = 0, shift = 0, byte: number
    do { byte = bytes[at++]!; result += (byte & 0x7f) * 2 ** shift; shift += 7 } while (byte & 0x80)
    return result
  }
  const skipName = () => { const length = leb(); at += length }
  while (at < bytes.length) {
    const id = bytes[at++]!, size = leb(), end = at + size
    if (id !== 2) { at = end; continue }
    for (let count = leb(); count > 0; count--) {
      skipName()
      skipName()
      const kind = bytes[at++]
      if (kind === 0) leb()
      else if (kind === 1) { at++; const flags = bytes[at++]!; leb(); if (flags & 1) leb() }
      else if (kind === 2) { const flags = bytes[at++]!; const initial = leb(); return { initial, maximum: flags & 1 ? leb() : initial } }
      else if (kind === 3) at += 2
      else if (kind === 4) { at++; leb() }
    }
    return undefined
  }
  return undefined
}

/** A core module built against WALI's musl: every import from `wali`, with its memory and `_start` exported */
function waliShaped(module: WebAssembly.Module): boolean {
  const imports = WebAssembly.Module.imports(module)
  const exports = WebAssembly.Module.exports(module)
  return imports.length > 0 && imports.every(entry => entry.module === 'wali') &&
    exports.some(entry => entry.name === 'memory' && entry.kind === 'memory') &&
    exports.some(entry => entry.name === '_start' && entry.kind === 'function')
}

/**
 * Every core module (WALI, `wasm32-wasip1`, `emcc`, or none of those) runs as a worker process under `/bin/wali` (see
 * `canRunInWorker`). What still runs here is a Preview 2 component, on the main thread, so an infinite loop freezes
 * the tab and `^C` cannot reach it; Phase 4 of `.docs/WASI_CLEANUP.md` gives components a worker too.
 */
export class Wasm implements IWasm {
  private _kernel: Kernel
  private _modules: Map<string, { module: WebAssembly.Module; instance: WebAssembly.Instance }> = new Map()

  get modules() { return this._modules }

  constructor(options: WasmOptions) {
    this._kernel = options.kernel
  }

  /**
   * Detect WASI version and requirements
   * Returns 'preview1', 'preview2', or null
   */
  async detectWasiVersion(wasmBytes: Uint8Array): Promise<'preview1' | 'preview2' | null> {
    // Check magic bytes: 0x00 0x61 0x73 0x6d ("\0asm")
    if (wasmBytes.length < 8 || 
        wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 || 
        wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) {
      return null
    }
    
    // Check version bytes at offset 4-7
    // Component Model: 0x0d 0x00 0x01 0x00 (layer 1, version 13)
    if (wasmBytes[4] === 0x0d && wasmBytes[5] === 0x00 && 
        wasmBytes[6] === 0x01 && wasmBytes[7] === 0x00) {
      return 'preview2'
    }
    
    // Core WASM: 0x01 0x00 0x00 0x00 (version 1)
    if (wasmBytes[4] === 0x01 && wasmBytes[5] === 0x00 && 
        wasmBytes[6] === 0x00 && wasmBytes[7] === 0x00) {
      // Further check imports for WASI
      try {
        const buffer = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) as ArrayBuffer
        const module = await WebAssembly.compile(buffer)
        const imports = WebAssembly.Module.imports(module)
        
        for (const imp of imports) {
          const moduleName = imp.module
          if (moduleName === 'wasi_snapshot_preview1') {
            return 'preview1'
          }
          if (moduleName.startsWith('wasi:')) {
            return 'preview2'
          }
        }
      } catch (error) {
        this._kernel.log.warn(`Failed to detect WASI version: ${(error as Error).message}`)
        return null
      }
    }
    
    return null
  }

  /**
   * Whether a module was built against WALI's musl (`utils/check-wali.sh`): a core module whose every import is from
   * `wali` (the Linux syscalls and the startup calls) and that exports its memory and `_start`.
   */
  async isWali(wasmBytes: Uint8Array): Promise<boolean> {
    if (wasmBytes.length < 8 || wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 || wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) return false
    if (wasmBytes[4] !== 0x01) return false
    try {
      const module = await WebAssembly.compile(wasmBytes as Uint8Array<ArrayBuffer>)
      return waliShaped(module)
    } catch {
      return false
    }
  }

  /**
   * Whether a module runs as a worker process under `/bin/wali`: any core module. A WALI module, a WASI one (whatever else
   * an `emcc` build adds; asyncify is fine) and one with no WASI imports all go; the worker says why a library, or a WASI
   * module with no memory, is not a program. The module is compiled once for all of these checks: a launch asks on every run.
   */
  async canRunInWorker(wasmBytes: Uint8Array): Promise<boolean> {
    return (await this.inspectForWorker(wasmBytes)).inWorker
  }

  async inspectForWorker(wasmBytes: Uint8Array): Promise<{ inWorker: boolean, wali?: { module: WebAssembly.Module, limits?: { initial: number, maximum: number } } }> {
    // a component (preview2) or anything that is not a core module has no worker to run in
    if (wasmBytes.length < 8 || wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 || wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) return { inWorker: false }
    if (wasmBytes[4] !== 0x01 || wasmBytes[5] !== 0x00 || wasmBytes[6] !== 0x00 || wasmBytes[7] !== 0x00) return { inWorker: false }
    try {
      const module = await WebAssembly.compile(wasmBytes as Uint8Array<ArrayBuffer>)
      if (waliShaped(module)) return { inWorker: true, wali: { module, limits: memoryImportLimits(wasmBytes) } }
      // Imports the host does not implement are stubbed by the worker (`runPreview1`): they stop the program only if called.
      // An asyncify-instrumented module only unwinds when an import it calls triggers it, which the host never does, so it
      // runs as if uninstrumented.
      return { inWorker: true }
    } catch {
      return { inWorker: false }
    }
  }

  /**
   * Load a WASI component with stream integration
   * Supports both WASI Preview 1 and Preview 2
   */
  async loadWasiComponent(path: string, streams: WasiStreamOptions, args: string[] = [], shell?: Shell): Promise<WasiComponentResult> {
    const wasmBytes = await this._kernel.filesystem.fs.readFile(path)
    const version = await this.detectWasiVersion(wasmBytes)
    
    // a core module runs as a worker process (`inspectForWorker`); only a component gets here
    if (version !== 'preview2') throw new Error(`${path}: not a WebAssembly component`)

    return this.loadWasiPreview2(path, wasmBytes, streams, args, shell || this._kernel.shell)
  }
  /**
   * Load WASI Preview 2 component
   * Uses jco to transpile component model to core wasm + JS, then uses preview2-shim
   */
  private async loadWasiPreview2(path: string, wasmBytes: Uint8Array, streams: WasiStreamOptions, args: string[], shell: Shell): Promise<WasiComponentResult> {
    const result = await createWasiPreview2Bindings({
      kernel: this._kernel,
      streams,
      args,
      shell,
      wasmBytes
    })
    this._modules.set(path, {
      module: null as unknown as WebAssembly.Module,
      instance: result.instance
    })
    return result
  }
}
