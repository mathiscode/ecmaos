import type { Kernel, WasmOptions, Wasm as IWasm } from '@ecmaos/types'

import type { ProgramModule } from './lib/warm-threads'

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
 * Every wasm program (a core module: WALI, `wasm32-wasip1`, `emcc` or none of those; a Preview 2 component) runs as a worker
 * process under `/bin/wali` (see `canRunInWorker`). What stays here is the work the worker cannot do: compiling a module once
 * for the checks a launch asks, and transpiling a component with jco, which is too large for the worker's bundle.
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

  async inspectForWorker(wasmBytes: Uint8Array): Promise<{ inWorker: boolean, wali?: ProgramModule }> {
    // a component (preview2) is transpiled here and run by the worker
    if (await this.detectWasiVersion(wasmBytes) === 'preview2' && wasmBytes[4] === 0x0d) {
      try {
        return { inWorker: true, wali: await this.prepareComponent(wasmBytes) }
      } catch {
        return { inWorker: false }
      }
    }
    // anything else that is not a core module has no worker to run in
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
   * Transpiles a Preview 2 component with jco, which is too large for the worker's bundle: the worker is sent the
   * generated JavaScript and the compiled core modules (`/bin/wali`'s `runComponent`).
   */
  async prepareComponent(wasmBytes: Uint8Array): Promise<ProgramModule> {
    const { generate } = await import('@bytecodealliance/jco/component')
    const { files, imports, exports } = await generate(wasmBytes, {
      name: 'component',
      instantiation: { tag: 'async' },
      noTypescript: true,
      asyncMode: { tag: 'sync' }
    })
    const modules: Record<string, WebAssembly.Module> = {}
    let js = ''
    for (const [name, bytes] of files) {
      if (name === 'component.js') js = new TextDecoder().decode(bytes)
      else if (name.endsWith('.wasm')) modules[name] = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>)
    }
    if (!js) throw new Error('jco produced no component.js')
    return { component: { js, modules, exports: exports.map(([name]) => name), imports } }
  }
}
