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

/** The module's entry point for the loader: instantiates the component when the module starts, with its context */
export function wasmModule(bytes: Uint8Array): KernelModule {
  let life: { init(): void, exit(): void } | undefined
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
      const bound: { hooks?: Hooks } = {}
      const need = () => bound.hooks ?? (() => { throw new WasmModuleError('ENOEXEC', `${ctx.name}: the module has not finished starting`) })()
      /** `option<string>`: nothing is success, a string is why not */
      const attempt = (run: () => void) => {
        try { run() } catch (error) { return error instanceof Error ? error.message : String(error) }
        return undefined
      }

      const kernel = {
        log: (level: string, message: string) => ctx.log[level === 'warn' || level === 'error' ? level : 'info'](message),
        param: (name: string) => { const value = ctx.param(name); return value === undefined ? undefined : String(value) },
        proc: (path: string, writable: boolean) => attempt(() => ctx.proc(path, { show: () => need().procShow(path), store: writable ? value => need().procStore(path, value) : undefined })),
        sys: (path: string, attributes: Array<[string, boolean]>) => attempt(() => ctx.sys(path, Object.fromEntries(attributes.map(([name, writable]) => [name, {
          show: () => need().sysShow(path, name),
          store: writable ? (value: string) => need().sysStore(path, name, value) : undefined
        }])))),
        debugfsFile: (path: string, writable: boolean) => attempt(() => ctx.debugfs.file(path, { read: () => need().debugfsRead(path), write: writable ? value => need().debugfsWrite(path, value) : undefined })),
        syscall: (name: string) => attempt(() => ctx.syscall(name, (call, ...args) => need().syscallCall(name, call.pid, call.uid, call.gid, args.map(arg => typeof arg === 'number' ? { tag: 'number', val: arg } : { tag: 'text', val: arg })))),
        syscallPolicy: () => attempt(() => ctx.syscallPolicy(call => need().syscallAllowed(call.syscall, call.pid, call.uid, call.exe))),
        binfmt: (name: string, interpreter: string) => attempt(() => ctx.binfmt({ name, interpreter, matches: ({ filename, magic }) => need().binfmtMatches(name, filename, magic) }))
      }

      const shim = cli.createCli({
        arguments: [],
        environment: {},
        initialCwd: '/',
        stdin: { read: () => { throw { tag: 'closed' } }, blockingRead: () => { throw { tag: 'closed' } }, subscribe: () => io.pollableCreate() } as never,
        stdout: lines(line => ctx.log.info(line)) as never,
        stderr: lines(line => ctx.log.warn(line)) as never
      })
      const imports: Record<string, unknown> = {
        'ecmaos:module/kernel': kernel,
        'ecmaos:module/kernel@0.1.0': kernel,
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
        'wasi:random/insecure-seed': random.insecureSeed,
        'wasi:filesystem/preopens': denied('the filesystem'),
        'wasi:filesystem/types': denied('the filesystem'),
        'wasi:http/outgoing-handler': denied('HTTP'),
        'wasi:http/types': denied('HTTP'),
        'wasi:sockets/instance-network': denied('the network'),
        'wasi:sockets/ip-name-lookup': denied('the network'),
        'wasi:sockets/network': denied('the network'),
        'wasi:sockets/tcp': denied('the network'),
        'wasi:sockets/tcp-create-socket': denied('the network'),
        'wasi:sockets/udp': denied('the network'),
        'wasi:sockets/udp-create-socket': denied('the network')
      }

      const component = await generated.instantiate(async name => {
        const core = output.get(name)
        if (!core) throw new WasmModuleError('ENOEXEC', `${ctx.name}: jco produced no ${name}`)
        return WebAssembly.compile(core as Uint8Array<ArrayBuffer>)
      }, imports)

      life = (component['ecmaos:module/lifecycle@0.1.0'] ?? component['ecmaos:module/lifecycle'] ?? component['lifecycle']) as typeof life
      bound.hooks = (component['ecmaos:module/hooks@0.1.0'] ?? component['ecmaos:module/hooks'] ?? component['hooks']) as Hooks | undefined
      if (!life || !bound.hooks) throw new WasmModuleError('ENOEXEC', `${ctx.name}: the component does not export ecmaos:module/lifecycle and hooks`)
      life.init()
    },
    exit() {
      life?.exit()
    }
  }
}
