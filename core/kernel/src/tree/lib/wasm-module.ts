/**
 * The WebAssembly kind of kernel module (`NAME.ko.wasm`): a component of the world in `wit/ecmaos-module.wit`. The file is an
 * ordinary component with two custom sections, `ecmaos-module` (the modinfo, the `key=value` lines of a JS module's header)
 * and, after signing, `ecmaos-module-signature` as the last section (the lines `signer`, `key_id` and `sig`, an Ed25519
 * signature over every byte before the section). Reading either takes bytes and runs nothing.
 *
 * Running one: jco turns the component into JavaScript and core modules, and the module gets the `ecmaos:module/kernel`
 * import, which does what the JS context does, and the WASI interfaces a toolchain adds, answered with a clock, random bytes
 * and a place to write log lines. The filesystem, the sockets and HTTP are refused, so the only way out of the module is the
 * world it declares.
 */

import * as cli from '@bytecodealliance/preview2-shim/cli'
import * as clocks from '@bytecodealliance/preview2-shim/clocks'
import * as io from '@bytecodealliance/preview2-shim/io'
import * as random from '@bytecodealliance/preview2-shim/random'
import type { KernelModule, ModuleContext } from '@ecmaos/types'
import { WasmFS, type WasmFilesystemExports } from './wasm-filesystem.ts'

export const WASM_MODINFO_SECTION = 'ecmaos-module'
export const WASM_SIGNATURE_SECTION = 'ecmaos-module-signature'

const MAGIC = [0x00, 0x61, 0x73, 0x6d]

export class WasmModuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export const isWasm = (source: string | Uint8Array): source is Uint8Array =>
  typeof source !== 'string' && source.length >= 8 && MAGIC.every((byte, index) => source[index] === byte)

export interface WasmSection {
  id: number
  /** Where the section starts (its id byte), and where its contents and the next section start */
  start: number
  payload: number
  end: number
  /** Custom sections only */
  name?: string
}

function leb(bytes: Uint8Array, at: number): [number, number] {
  let value = 0
  let shift = 0
  for (let index = at; index < bytes.length; index++) {
    const byte = bytes[index]!
    value += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return [value, index + 1]
    shift += 7
    if (shift > 35) break
  }
  throw new WasmModuleError('ENOEXEC', 'invalid module format: bad section size')
}

/** The sections at the top level of a component (or core module) */
export function wasmSections(bytes: Uint8Array): WasmSection[] {
  if (!isWasm(bytes)) throw new WasmModuleError('ENOEXEC', 'invalid module format: not a WebAssembly file')
  const sections: WasmSection[] = []
  for (let at = 8; at < bytes.length;) {
    const id = bytes[at]!
    const [size, payload] = leb(bytes, at + 1)
    const end = payload + size
    if (end > bytes.length) throw new WasmModuleError('ENOEXEC', 'invalid module format: a section runs past the end of the file')
    const section: WasmSection = { id, start: at, payload, end }
    if (id === 0) {
      const [length, nameAt] = leb(bytes, payload)
      section.name = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + length))
      section.payload = nameAt + length
    }
    sections.push(section)
    at = end
  }
  return sections
}

/** The text of a custom section, if the file has one by that name (the last, if several) */
export function wasmCustomSection(bytes: Uint8Array, name: string): string | undefined {
  const section = wasmSections(bytes).filter(entry => entry.id === 0 && entry.name === name).at(-1)
  return section && new TextDecoder().decode(bytes.subarray(section.payload, section.end))
}

/** The bytes of a custom section with this name and text, to append to a file */
export function wasmCustomSectionBytes(name: string, text: string): Uint8Array {
  const encode = (value: number) => {
    const out: number[] = []
    do {
      let byte = value & 0x7f
      value = Math.floor(value / 128)
      if (value) byte |= 0x80
      out.push(byte)
    } while (value)
    return out
  }
  const nameBytes = new TextEncoder().encode(name)
  const body = new TextEncoder().encode(text)
  const inner = [...encode(nameBytes.length), ...nameBytes, ...body]
  return Uint8Array.from([0, ...encode(inner.length), ...inner])
}

/** Splits a file into the bytes a signature covers and the trailer's fields, if the last section is a signature */
export function splitWasmSignature(bytes: Uint8Array): { body: Uint8Array, signer?: string, keyId?: string, sig?: Uint8Array } {
  const last = wasmSections(bytes).at(-1)
  if (!last || last.id !== 0 || last.name !== WASM_SIGNATURE_SECTION) return { body: bytes }
  const fields = new Map<string, string>()
  for (const line of new TextDecoder().decode(bytes.subarray(last.payload, last.end)).split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  let sig: Uint8Array | undefined
  try { sig = fields.has('sig') ? Uint8Array.from(atob(fields.get('sig')!), char => char.charCodeAt(0)) : undefined } catch { sig = undefined }
  return { body: bytes.subarray(0, last.start), signer: fields.get('signer'), keyId: fields.get('key_id'), sig }
}

const refused = (what: string) => new Error(`${what} is not available to a module`)
/** An interface the module may not use: any function throws, any resource cannot be made */
export const denied = (what: string) => new Proxy({}, {
  get: (_, property) => typeof property !== 'string' ? undefined : /^[A-Z]/.test(property)
    ? class { constructor() { throw refused(what) } }
    : () => { throw refused(what) }
})

/** Whether a component imports WASI 0.3: the interface names are in the file as text, `wasi:cli/stdout@0.3.0` and so on */
export function usesPreview3(bytes: Uint8Array): boolean {
  const needle = new TextEncoder().encode('wasi:')
  const version = new TextEncoder().encode('@0.3.')
  for (let at = bytes.indexOf(needle[0]!); at !== -1 && at < bytes.length; at = bytes.indexOf(needle[0]!, at + 1)) {
    if (!needle.every((byte, index) => bytes[at + index] === byte)) continue
    // the version follows the interface name, a few dozen bytes on at most
    for (let end = at + needle.length; end < Math.min(bytes.length, at + 80) && bytes[end]! >= 0x2d; end++) {
      if (version.every((byte, index) => bytes[end + index] === byte)) return true
    }
  }
  return false
}

/** Turns what a module writes to its standard streams into kernel log lines */
function lines(write: (line: string) => void) {
  let pending = ''
  const handle = (contents: Uint8Array) => {
    pending += new TextDecoder().decode(contents)
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) if (line) write(line)
  }
  return { write: handle, flush() {}, blockingFlush() {}, blockingWriteAndFlush: handle }
}

type Argument = { tag: 'text' | 'number', val: string | number }

interface Hooks {
  procShow(path: string): string
  procStore(path: string, value: string): void
  sysShow(path: string, attribute: string): string
  sysStore(path: string, attribute: string, value: string): void
  debugfsRead(path: string): string
  debugfsWrite(path: string, value: string): void
  syscallCall(name: string, pid: number, uid: number, gid: number, args: Argument[]): number
  syscallAllowed(syscall: string, pid: number, uid: number, exe: string | undefined): boolean
  binfmtMatches(name: string, filename: string, magic: Uint8Array): boolean
}

/**
 * The WASI 0.3 interfaces a component links against, answered the way the 0.2 ones are: no arguments, environment or input,
 * output as log lines, a clock, and no terminal. `preview3-shim`'s browser build is not used: it only throws, and a module
 * should get exactly this much and no more.
 */
function preview3Imports(ctx: ModuleContext): Record<string, unknown> {
  /** Reads a `stream<u8>` the module wrote to, line by line, as the stream yields chunks */
  const drain = async (stream: unknown, write: (line: string) => void) => {
    const sink = lines(write)
    const source = stream as AsyncIterable<Uint8Array | number[]> | undefined
    if (source && typeof source[Symbol.asyncIterator] === 'function') {
      for await (const chunk of source) sink.write(Uint8Array.from(chunk))
    }
  }
  const nothing = { }
  const exit = () => { throw new Error('a module cannot end the kernel') }
  const monotonic = () => BigInt(Math.round(performance.now() * 1_000_000))
  return {
    'wasi:cli/environment': { getEnvironment: () => [], getArguments: () => [], getInitialCwd: () => undefined },
    'wasi:cli/exit': { exit, exitWithCode: exit },
    'wasi:cli/stdin': { readViaStream: () => [(async function* () { /* ends at once */ })(), Promise.resolve({ tag: 'ok' })] },
    'wasi:cli/stdout': { writeViaStream: (data: unknown) => drain(data, line => ctx.log.info(line)).then(() => ({ tag: 'ok' })) },
    'wasi:cli/stderr': { writeViaStream: (data: unknown) => drain(data, line => ctx.log.warn(line)).then(() => ({ tag: 'ok' })) },
    'wasi:cli/terminal-input': { TerminalInput: class {} },
    'wasi:cli/terminal-output': { TerminalOutput: class {} },
    'wasi:cli/terminal-stdin': { getTerminalStdin: () => undefined },
    'wasi:cli/terminal-stdout': { getTerminalStdout: () => undefined },
    'wasi:cli/terminal-stderr': { getTerminalStderr: () => undefined },
    'wasi:clocks/monotonic-clock': {
      now: monotonic,
      getResolution: () => 1_000n,
      waitUntil: async (when: bigint) => { await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(when - monotonic()) / 1_000_000))) },
      waitFor: async (howLong: bigint) => { await new Promise(resolve => setTimeout(resolve, Number(howLong) / 1_000_000)) }
    },
    'wasi:clocks/system-clock': {
      now: () => { const ms = Date.now(); return { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1_000_000 } },
      getResolution: () => 1_000_000n
    },
    'wasi:clocks/types': nothing,
    'wasi:cli/types': nothing
  }
}

/** The module's entry point for the loader: instantiates the component when the module starts, with its context */
/** `parameters` are the names the modinfo declares; their values are passed to `init` */
export function wasmModule(bytes: Uint8Array, parameters: string[] = []): KernelModule {
  let life: { init(params: Array<[string, string]>): unknown, exit(): void } | undefined
  return {
    async init(ctx: ModuleContext) {
      const { generate } = await import('@bytecodealliance/jco/component')
      const { files } = await generate(bytes, { name: 'component', instantiation: { tag: 'async' }, noTypescript: true, asyncMode: { tag: 'sync' } })
      const output = new Map<string, Uint8Array>(files)
      const js = output.get('component.js')
      if (!js) throw new WasmModuleError('ENOEXEC', `${ctx.name}: jco produced no component.js`)
      const source = new TextDecoder().decode(js)
      let binary = ''
      const encoded = new TextEncoder().encode(source)
      for (let index = 0; index < encoded.length; index += 0x8000) binary += String.fromCharCode(...encoded.subarray(index, index + 0x8000))
      const generated = await import(/* @vite-ignore */ `data:text/javascript;base64,${btoa(binary)}`) as {
        instantiate: (getCoreModule: (name: string) => Promise<WebAssembly.Module>, imports: Record<string, unknown>) => Promise<Record<string, unknown>>
      }

      // the kernel calls the module back through these, once it has finished starting
      const bound: { hooks?: Hooks, filesystem?: WasmFilesystemExports } = {}
      const filesystemExported = /ecmaos:module\/filesystem/.test(new TextDecoder('latin1').decode(bytes))
      const need = () => bound.hooks ?? (() => { throw new WasmModuleError('ENOEXEC', `${ctx.name}: the module has not finished starting`) })()
      /** A number for the module, never text: 0 is success, otherwise an errno; the reason goes to the kernel log */
      const errnos: Record<string, number> = { EPERM: 1, EIO: 5, EEXIST: 17, ENOTDIR: 20, EINVAL: 22, ENOSYS: 38 }
      const attempt = (run: () => void) => {
        try {
          run()
          return 0
        } catch (error) {
          ctx.log.warn(error instanceof Error ? error.message : String(error))
          return errnos[(error as { code?: string }).code ?? ''] ?? errnos.EIO!
        }
      }

      // WASI 0.3: jco makes every export of such a component async, and the kernel's /proc, /sys and debugfs files, the
      // syscall policy and the program-format check must answer at once. A file is served from the last text the module's hook
      // returned (primed once `init` is done, refreshed after each read, and after each write), and a policy or format cannot
      // be added by a 0.3 module at all: refused, rather than quietly allowing everything.
      const asynchronous = usesPreview3(bytes)
      const primers: Array<() => Promise<unknown>> = []
      const served = (call: () => unknown) => {
        let text = ''
        const refresh = async () => {
          try { text = String(await call()) } catch (error) { ctx.log.warn(`hook failed: ${error instanceof Error ? error.message : String(error)}`) }
        }
        if (asynchronous) primers.push(refresh)
        return () => {
          const answer = call()
          if (answer && typeof (answer as { then?: unknown }).then === 'function') {
            void refresh()
            return text
          }
          return String(answer)
        }
      }
      const written = (call: (value: string) => unknown) => (value: string) => {
        const answer = call(value)
        if (answer && typeof (answer as { then?: unknown }).then === 'function') void (answer as Promise<unknown>).catch((error: unknown) => ctx.log.warn(`write refused: ${error instanceof Error ? error.message : String(error)}`))
      }
      const unsupported = (what: string) => () => {
        ctx.log.warn(`${what} cannot be added by a WASI 0.3 module: its hooks are asynchronous and the kernel needs the answer at once`)
        return errnos.ENOSYS!
      }

      const kernel = {
        log: (level: string, message: string) => ctx.log[level === 'warn' || level === 'error' ? level : 'info'](message),
        proc: (path: string, writable: boolean) => attempt(() => ctx.proc(path, { show: served(() => need().procShow(path)), store: writable ? written(value => need().procStore(path, value)) : undefined })),
        sys: (path: string, attributes: Array<[string, boolean]>) => attempt(() => ctx.sys(path, Object.fromEntries(attributes.map(([name, writable]) => [name, {
          show: served(() => need().sysShow(path, name)),
          store: writable ? written(value => need().sysStore(path, name, value)) : undefined
        }])))),
        debugfsFile: (path: string, writable: boolean) => attempt(() => ctx.debugfs.file(path, { read: served(() => need().debugfsRead(path)), write: writable ? written(value => need().debugfsWrite(path, value)) : undefined })),
        syscall: (name: string) => attempt(() => ctx.syscall(name, async (call, ...args) => await need().syscallCall(name, call.pid, call.uid, call.gid, args.map(arg => typeof arg === 'number' ? { tag: 'number', val: arg } : { tag: 'text', val: arg })))),
        filesystem: (name: string, source: string) => attempt(() => {
          if (!bound.filesystem && !filesystemExported) throw Object.assign(new Error('a filesystem type needs the filesystem-module world'), { code: 'ENOSYS' })
          if (source !== 'none' && source !== 'optional' && source !== 'required') throw Object.assign(new Error(`bad source '${source}'`), { code: 'EINVAL' })
          ctx.filesystem({
            name,
            source,
            backend: { name, options: {}, create: (options: { source?: string, options?: Record<string, string> }) => new WasmFS(() => bound.filesystem ?? (() => { throw new WasmModuleError('ENOEXEC', `${ctx.name}: the module has not finished starting`) })(), name, { source: options.source ?? '', options: options.options ?? {} } ) },
            config: request => ({ source: request.source, options: request.options })
          })
        }),
        syscallPolicy: asynchronous ? unsupported('a syscall policy') : () => attempt(() => ctx.syscallPolicy(call => need().syscallAllowed(call.syscall, call.pid, call.uid, call.exe))),
        binfmt: asynchronous ? unsupported('a program format') : (name: string, interpreter: string) => attempt(() => ctx.binfmt({ name, interpreter, matches: ({ filename, magic }) => need().binfmtMatches(name, filename, magic) }))
      }

      const imports: Record<string, unknown> = { 'ecmaos:module/kernel': kernel, 'ecmaos:module/kernel@0.1.0': kernel }
      if (usesPreview3(bytes)) {
        Object.assign(imports, preview3Imports(ctx))
      } else {
        const shim = cli.createCli({
          arguments: [],
          environment: {},
          initialCwd: '/',
          stdin: { read: () => { throw { tag: 'closed' } }, blockingRead: () => { throw { tag: 'closed' } }, subscribe: () => io.pollableCreate() } as never,
          stdout: lines(line => ctx.log.info(line)) as never,
          stderr: lines(line => ctx.log.warn(line)) as never
        })
        Object.assign(imports, {
          'wasi:cli/environment': shim.environment,
          'wasi:cli/exit': shim.exit,
          'wasi:cli/stdin': shim.stdin,
          'wasi:cli/stdout': shim.stdout,
          'wasi:cli/stderr': shim.stderr,
          'wasi:cli/terminal-input': shim.terminalInput,
          'wasi:cli/terminal-output': shim.terminalOutput,
          'wasi:cli/terminal-stdin': shim.terminalStdin,
          'wasi:cli/terminal-stdout': shim.terminalStdout,
          'wasi:cli/terminal-stderr': shim.terminalStderr,
          'wasi:clocks/monotonic-clock': clocks.monotonicClock,
          'wasi:clocks/wall-clock': clocks.wallClock,
          'wasi:io/error': io.error,
          'wasi:io/poll': io.poll,
          'wasi:io/streams': io.streams,
          'wasi:random/random': random.random,
          'wasi:random/insecure': random.insecure,
          'wasi:random/insecure-seed': random.insecureSeed
        })
      }
      // whichever version it is, these are refused
      Object.assign(imports, {
        'wasi:filesystem/preopens': denied('the filesystem'),
        'wasi:filesystem/types': denied('the filesystem'),
        'wasi:http/outgoing-handler': denied('HTTP'),
        'wasi:http/types': denied('HTTP'),
        'wasi:http/client': denied('HTTP'),
        'wasi:sockets/instance-network': denied('the network'),
        'wasi:sockets/ip-name-lookup': denied('the network'),
        'wasi:sockets/network': denied('the network'),
        'wasi:sockets/tcp': denied('the network'),
        'wasi:sockets/tcp-create-socket': denied('the network'),
        'wasi:sockets/udp': denied('the network'),
        'wasi:sockets/udp-create-socket': denied('the network'),
        'wasi:sockets/types': denied('the network'),
        'wasi:sockets/ip-name-lookup@0.3.0': denied('the network')
      })

      const component = await generated.instantiate(async name => {
        const core = output.get(name)
        if (!core) throw new WasmModuleError('ENOEXEC', `${ctx.name}: jco produced no ${name}`)
        return WebAssembly.compile(core as Uint8Array<ArrayBuffer>)
      }, imports)

      life = (component['ecmaos:module/lifecycle@0.1.0'] ?? component['ecmaos:module/lifecycle'] ?? component['lifecycle']) as typeof life
      bound.hooks = (component['ecmaos:module/hooks@0.1.0'] ?? component['ecmaos:module/hooks'] ?? component['hooks']) as Hooks | undefined
      bound.filesystem = (component['ecmaos:module/filesystem@0.1.0'] ?? component['ecmaos:module/filesystem'] ?? component['filesystem']) as WasmFilesystemExports | undefined
      if (!life || !bound.hooks) throw new WasmModuleError('ENOEXEC', `${ctx.name}: the component does not export ecmaos:module/lifecycle and hooks`)
      const values: Array<[string, string]> = []
      for (const name of parameters) {
        const value = ctx.param(name)
        if (value !== undefined) values.push([name, String(value)])
      }
      await life.init(values)
      for (const prime of primers) await prime()
    },
    exit() {
      life?.exit()
    }
  }
}
