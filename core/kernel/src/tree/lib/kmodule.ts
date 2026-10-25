/**
 * Loadable kernel modules: the file format, `insmod` and `rmmod`. A module is one bundled file, `NAME.ko.mjs`, that starts
 * with a comment block of `key=value` lines (its modinfo), so `modinfo` and a signature check read bytes and never run it.
 * The `Module` class of `@zenfs/linux` keeps the module list that `/proc/modules` and `/sys/module` show.
 */

import semver from 'semver'
import { Module, find_module, modules as loadedModules } from '@zenfs/linux'
import type { KernelModule, ModuleContext, ModuleInfo } from '@ecmaos/types'

import { createHooks, type HookHost } from './module-hooks.ts'

/** The module API this kernel offers; a module's `kernel_api` range is checked against it */
export const KERNEL_API_VERSION = '1.0.0'

export class ModuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const HEADER = /^\s*\/\*\s*ecmaos-module\b([\s\S]*?)\*\//
const TRAILER = /\/\* ecmaos-module-signature\b([\s\S]*?)\*\/\s*$/

/** A key `sign-module` made: the raw 32 bytes of an Ed25519 public key, as base64 in a `NAME.pub` file */
export interface TrustedKey { name: string, pub: Uint8Array }

/** What a module's signature came to: `none` (no trailer), `unknown-key` (nobody trusted signed it), `bad` (a trusted key does not match the bytes), `valid` */
export interface ModuleSignature {
  state: 'none' | 'valid' | 'unknown-key' | 'bad'
  signer?: string
  keyId?: string
  /** Name of the trusted key file that checked it */
  key?: string
}

const toHex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
const fromBase64 = (text: string) => Uint8Array.from(atob(text.replace(/\s+/g, '')), char => char.charCodeAt(0))

/** The short name of a public key that a signature trailer carries: the first 8 bytes of its SHA-256, in hex */
export async function keyIdOf(pub: Uint8Array) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', pub as BufferSource)).subarray(0, 8))
}

/** Reads a `NAME.pub` file: base64 of 32 bytes, with `#` comment lines allowed */
export function parsePublicKey(text: string): Uint8Array | undefined {
  const line = text.split('\n').map(entry => entry.trim()).find(entry => entry && !entry.startsWith('#'))
  if (!line) return undefined
  try {
    const bytes = fromBase64(line)
    return bytes.length === 32 ? bytes : undefined
  } catch {
    return undefined
  }
}

/** Splits a module file into the bytes that are signed and the signature trailer after them, if there is one */
export function splitSignature(source: string): { body: string, signer?: string, keyId?: string, sig?: Uint8Array } {
  const trailer = TRAILER.exec(source)
  if (!trailer) return { body: source }
  const fields = new Map<string, string>()
  for (const raw of trailer[1]!.split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trim()
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  let sig: Uint8Array | undefined
  try { sig = fields.has('sig') ? fromBase64(fields.get('sig')!) : undefined } catch { sig = undefined }
  return { body: source.slice(0, trailer.index), signer: fields.get('signer'), keyId: fields.get('key_id'), sig }
}

/** Checks a module file's signature against the trusted keys; reads bytes and runs nothing */
export async function checkSignature(source: string, keys: TrustedKey[]): Promise<ModuleSignature> {
  const { body, signer, keyId, sig } = splitSignature(source)
  if (body === source) return { state: 'none' }
  const claimed = { signer, keyId }
  if (!sig) return { state: 'bad', ...claimed }
  const bytes = new TextEncoder().encode(body)
  let known = false
  for (const key of keys) {
    if (keyId && await keyIdOf(key.pub) !== keyId) continue
    known = true
    try {
      const imported = await crypto.subtle.importKey('raw', key.pub as BufferSource, 'Ed25519', false, ['verify'])
      if (await crypto.subtle.verify('Ed25519', imported, sig as BufferSource, bytes)) return { state: 'valid', ...claimed, key: key.name }
    } catch { /* a key this runtime cannot use is the same as one that does not match */ }
  }
  return { state: known ? 'bad' : 'unknown-key', ...claimed }
}

/** Reads the modinfo block at the start of a module file; does not run anything */
export function parseModinfo(source: string): ModuleInfo {
  const header = HEADER.exec(source)
  if (!header) throw new ModuleError('ENOEXEC', 'invalid module format: no ecmaos-module header')

  const info: ModuleInfo = { name: '', depends: [], alias: [], parm: [], fields: [] }
  for (const raw of header[1]!.split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trimEnd()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at < 1) throw new ModuleError('ENOEXEC', `invalid module format: bad modinfo line '${line}'`)
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    info.fields.push([key, value])
    switch (key) {
      case 'name': info.name = value; break
      case 'version': info.version = value; break
      case 'description': info.description = value; break
      case 'license': info.license = value; break
      case 'kernel_api': info.kernelApi = value; break
      case 'author': (info.author ??= []).push(value); break
      case 'depends': info.depends.push(...value.split(',').map(name => name.trim()).filter(Boolean)); break
      case 'alias': info.alias.push(value); break
      case 'parm': {
        const [name, type, ...description] = value.split(':')
        if (!name || (type !== 'string' && type !== 'number' && type !== 'boolean')) {
          throw new ModuleError('ENOEXEC', `invalid module format: bad parm '${value}' (want name:string|number|boolean:description)`)
        }
        info.parm.push({ name, type, description: description.join(':') })
        break
      }
    }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(info.name)) throw new ModuleError('ENOEXEC', 'invalid module format: name is missing or has odd characters')
  return info
}

/** Whether the module API of this kernel is inside the range a module asks for; a module that asks for none runs anywhere */
export function acceptsApi(range: string | undefined, api = KERNEL_API_VERSION) {
  if (!range) return true
  return semver.validRange(range) !== null && semver.satisfies(api, range)
}

/** Reads `name=value` words, as typed after `insmod NAME`; a value in double quotes may hold spaces */
export function parseParams(words: string[], info: ModuleInfo): Map<string, string | number | boolean> {
  const values = new Map<string, string | number | boolean>()
  for (const word of words) {
    const at = word.indexOf('=')
    const key = at === -1 ? word : word.slice(0, at)
    const text = at === -1 ? 'true' : word.slice(at + 1).replace(/^"(.*)"$/, '$1')
    const parm = info.parm.find(entry => entry.name === key)
    if (!parm) throw new ModuleError('ENOENT', `${info.name}: unknown parameter '${key}'`)
    if (parm.type === 'number') {
      const number = Number(text)
      if (text === '' || Number.isNaN(number)) throw new ModuleError('EINVAL', `${info.name}: ${key} wants a number, not '${text}'`)
      values.set(key, number)
    } else if (parm.type === 'boolean') {
      if (!/^(1|0|y|n|true|false|yes|no|on|off)$/i.test(text)) throw new ModuleError('EINVAL', `${info.name}: ${key} wants a boolean, not '${text}'`)
      values.set(key, /^(1|y|true|yes|on)$/i.test(text))
    } else {
      values.set(key, text)
    }
  }
  return values
}

export interface LoadOptions {
  /** `insmod -f`: loads a module whose `kernel_api` does not match, tainted `F` */
  force?: boolean
  params?: string[]
}

export interface ModuleHost extends Partial<Pick<HookHost, 'commands' | 'fstypes' | 'binfmts' | 'syscalls'>> {
  log: { info(message: string): void, warn(message: string): void, error(message: string): void }
  /** Turns module source into the object it exports */
  evaluate(source: string): Promise<unknown>
  /** Kernel log line (dmesg) */
  dmesg(line: string): void
  /** The public keys in `/etc/modules-keys`, read each time a module is checked */
  keys(): Promise<TrustedKey[]>
}

/**
 * The module layer of one kernel. The symbol table and the undo lists are here; the list of modules is `@zenfs/linux`'s.
 */
export class ModuleManager {
  /** `/proc/sys/kernel/modules_disabled`: once set, nothing loads or unloads, and it cannot be cleared */
  #disabled = false
  /** `/proc/sys/kernel/module_sig_enforce`: once set, only a module signed by a trusted key loads, and it cannot be cleared */
  #enforce = false
  readonly #symbols = new Map<string, { owner: Module, value: unknown }>()
  /** Questions a module asks of the world before it may unload (a mounted filesystem of its own): the answer is a reason, or nothing */
  readonly #busy = new Map<Module, Array<() => string | undefined>>()
  readonly #provided = new Map<string, unknown>()
  readonly #infos = new Map<string, { info: ModuleInfo, size: number, signature: ModuleSignature }>()
  #warnedTaint = false

  constructor(private readonly host: ModuleHost) {}

  get disabled() { return this.#disabled }
  disable() { this.#disabled = true }

  get enforcing() { return this.#enforce }
  enforce() { this.#enforce = true }

  /** The signature of a module file against the keys trusted now */
  async verify(source: string) { return checkSignature(source, await this.host.keys()) }

  /** `/proc/sys/kernel/tainted`: the bits of every taint a loaded module has set */
  get tainted() {
    let bits = 0
    for (const mod of loadedModules.values()) {
      if (mod.taints.has('P')) bits |= 1
      if (mod.taints.has('F')) bits |= 2
      if (mod.taints.has('E')) bits |= 1 << 13
      if (mod.taints.has('O')) bits |= 1 << 12
      if (mod.taints.has('C')) bits |= 1 << 10
    }
    return bits
  }

  info(name: string) { return this.#infos.get(name)?.info }
  /** Bytes of the module file, what `lsmod` shows as its size */
  size(name: string) { return this.#infos.get(name)?.size ?? 0 }
  signature(name: string) { return this.#infos.get(name)?.signature }

  /** Makes `value` importable by every module under `symbol`, like a symbol the kernel exports itself */
  provide(symbol: string, value: unknown) {
    this.#provided.set(symbol, value)
  }

  /** Every symbol modules export, and those the kernel provides (module ''), for `/proc/kallsyms` */
  symbols() {
    return [
      ...[...this.#provided.keys()].map(symbol => ({ symbol, module: '' })),
      ...[...this.#symbols].map(([symbol, entry]) => ({ symbol, module: entry.owner.name }))
    ].sort((a, b) => a.symbol.localeCompare(b.symbol))
  }

  async load(source: string, options: LoadOptions = {}): Promise<Module> {
    if (this.#disabled) throw new ModuleError('EPERM', 'module loading is disabled')
    const info = parseModinfo(source)
    if (find_module(info.name)) throw new ModuleError('EEXIST', `${info.name}: module already loaded`)

    // out of tree always; unsigned (E) unless a trusted key signed it. A signature that does not match is refused whatever the policy
    const signature = await this.verify(source)
    if (signature.state === 'bad') throw new ModuleError('EKEYREJECTED', `${info.name}: module verification failed: signature does not match`)
    if (signature.state !== 'valid' && this.#enforce) {
      throw new ModuleError('ENOKEY', `${info.name}: module verification failed: ${signature.state === 'none' ? 'module is not signed' : 'required key missing'}`)
    }
    const taints = new Set<'O' | 'E' | 'F'>(['O'])
    if (signature.state !== 'valid') taints.add('E')
    if (!acceptsApi(info.kernelApi)) {
      if (!options.force) throw new ModuleError('ENOEXEC', `${info.name}: invalid module format: needs kernel_api ${info.kernelApi}, this kernel has ${KERNEL_API_VERSION}`)
      taints.add('F')
    }
    const values = parseParams(options.params ?? [], info)

    const exported = await this.host.evaluate(source) as { default?: KernelModule } & Partial<KernelModule>
    const entry = (exported.default ?? exported) as Partial<KernelModule>
    if (typeof entry.init !== 'function') throw new ModuleError('ENOEXEC', `${info.name}: invalid module format: no init function`)

    const undo: Array<() => void | Promise<void>> = []
    const missing = info.depends.filter(name => !find_module(name))
    if (missing.length) throw new ModuleError('ENOENT', `${info.name}: unknown symbol: needs ${missing.join(', ')} loaded first`)

    const mod: Module = new Module({
      name: info.name,
      version: info.version,
      description: info.description,
      author: info.author,
      license: info.license,
      taints,
      params: Object.fromEntries(info.parm.map(parm => [parm.name, { value: values.get(parm.name) ?? (parm.type === 'number' ? 0 : parm.type === 'boolean' ? false : '') }])),
      init: async () => {
        for (const name of info.depends) mod.use(find_module(name)!)
        await entry.init!(this.#context(mod, undo))
      },
      exit: async () => {
        for (const step of undo.reverse()) await step()
        for (const [symbol, { owner }] of this.#symbols) if (owner === mod) this.#symbols.delete(symbol)
        await entry.exit?.()
      }
    })

    try {
      await mod.init()
    } catch (error) {
      for (const step of undo.reverse()) await step()
      for (const [symbol, { owner }] of this.#symbols) if (owner === mod) this.#symbols.delete(symbol)
      this.#busy.delete(mod)
      throw error
    }

    this.#infos.set(info.name, { info, size: new TextEncoder().encode(source).length, signature })
    if (signature.state !== 'valid') this.host.dmesg(`${info.name}: module verification failed: signature and/or required key missing - tainting kernel`)
    this.host.dmesg(`${info.name}: loading out-of-tree module taints kernel.`)
    this.host.dmesg(`${info.name}: module${info.version ? ` ${info.version}` : ''} loaded`)
    if (!this.#warnedTaint) {
      this.#warnedTaint = true
      this.host.dmesg('Disabling lock debugging due to kernel taint')
    }
    return mod
  }

  async unload(name: string, force = false) {
    if (this.#disabled) throw new ModuleError('EPERM', 'module loading is disabled')
    const mod = find_module(name)
    if (!mod) throw new ModuleError('ENOENT', `module ${name} is not currently loaded`)
    if (mod.refcnt > 0 && !force) throw new ModuleError('EBUSY', `module ${name} is in use`)
    if (!force) {
      for (const check of this.#busy.get(mod) ?? []) {
        const reason = check()
        if (reason) throw new ModuleError('EBUSY', `module ${name} is in use: ${reason}`)
      }
    }
    await mod.dispose(force)
    this.#busy.delete(mod)
    this.#infos.delete(name)
    this.host.dmesg(`${name}: module unloaded`)
  }

  #context(mod: Module, undo: Array<() => void | Promise<void>>): ModuleContext {
    const tag = (message: string) => `${mod.name}: ${message}`
    return {
      name: mod.name,
      param: name => mod.param(name) as never,
      log: {
        info: message => this.host.log.info(tag(message)),
        warn: message => this.host.log.warn(tag(message)),
        error: message => this.host.log.error(tag(message))
      },
      export: (symbol, value) => {
        const taken = this.#symbols.get(symbol)
        if (taken) throw new ModuleError('EEXIST', `${mod.name}: symbol ${symbol} is already exported by ${taken.owner.name}`)
        if (this.#provided.has(symbol)) throw new ModuleError('EEXIST', `${mod.name}: symbol ${symbol} is provided by the kernel`)
        this.#symbols.set(symbol, { owner: mod, value })
      },
      import: <T>(symbol: string) => {
        if (this.#provided.has(symbol)) return this.#provided.get(symbol) as T
        const entry = this.#symbols.get(symbol)
        if (!entry) throw new ModuleError('ENOENT', `${mod.name}: unknown symbol ${symbol}`)
        if (entry.owner !== mod && !mod.uses.has(entry.owner)) {
          mod.use(entry.owner)
          undo.push(() => mod.unuse(entry.owner))
        }
        return entry.value as T
      },
      onExit: step => { undo.push(step) },
      ...createHooks({ module: mod.name, host: this.host, undo, busy: check => { this.#busy.set(mod, [...(this.#busy.get(mod) ?? []), check]) }, fail: (code, message) => new ModuleError(code, message) })
    }
  }
}
