/**
 * Starts each program's worker ahead of time. `@zenfs/linux` makes a worker URL for an interpreter and caches it by
 * the bytes' identity, but `execve` reads the interpreter afresh every time, so every spawn encoded it again and kept
 * another URL. Here the URL is kept by the interpreter's content, and a worker per interpreter is started before it is
 * needed: a worker does nothing until the kernel's `init` message, so the next program takes one that has already
 * started and evaluated its interpreter (`/bin/node`, `/bin/wali`), and the worker start and the interpreter's load
 * are off the spawn's path. REMOVAL: the spare workers are ecmaOS's own; the URL cache could go upstream.
 */

import { set_thread_factory, type HostThread } from '@zenfs/linux'
import type { FromThread } from '@zenfs/linux/uapi/abi'

/** At most this many interpreters keep a URL and spare workers; an interpreter replaced on disk is a new one. */
const MAX_INTERPRETERS = 4
/** Workers kept started per interpreter; more made no difference to a script's loop or a long pipeline. */
const SPARES = 1

/** A host thread whose events are held until something listens, since a spare starts before its `Thread` does. */
interface Spare {
  host: HostThread
  /** Called when a spawn takes it: a Node worker keeps Node running only once it runs a program. */
  take(): void
}

interface Interpreter {
  bytes: Uint8Array
  url: URL
  spares: Array<Promise<Spare>>
}

const WebWorker = globalThis.Worker
/** Kept out of the import so it stays opaque to bundlers; a browser build never reaches it */
const nodeWorkerThreads = 'node:' + 'worker_threads'

/** A program the kernel has compiled already: what `/bin/wali` would otherwise read from the file and compile itself */
export interface ProgramModule {
  module: WebAssembly.Module
  limits?: { initial: number, maximum: number }
}

/** How many programs' modules are held: compiled code is large (python3's is tens of MB) */
const MAX_PROGRAMS = 8
const programs = new Map<string, ProgramModule>()

/**
 * Has the next worker for `exe` be sent its compiled module ahead of `init` (a program's threads and forks run the same
 * `exe`, so they are given it too). A worker takes it only if the `exe` it is started with is this one.
 */
export function provideProgramModule(exe: string, program: ProgramModule | undefined): void {
  programs.delete(exe)
  if (!program) return
  programs.set(exe, program)
  for (const old of [...programs.keys()].slice(0, Math.max(0, programs.size - MAX_PROGRAMS))) programs.delete(old)
}

const interpreters: Interpreter[] = []
let installed = false

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (native) return native.call(bytes)
  let text = ''
  for (let i = 0; i < bytes.byteLength; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

function urlFor(bytes: Uint8Array): URL {
  // Node won't take a blob URL for a worker, but it does read a module out of a `data:` URL
  if (WebWorker) return new URL(URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/javascript' })))
  return new URL('data:text/javascript;base64,' + base64(bytes))
}

/** Event lists that keep what arrives before the first listener and hand it over when one comes. */
function channel<T>() {
  const handlers: Array<(value: T) => void> = []
  const held: T[] = []
  return {
    emit(value: T) {
      if (!handlers.length) held.push(value)
      for (const handler of handlers) handler(value)
    },
    listen(handler: (value: T) => void) {
      handlers.push(handler)
      for (const value of held.splice(0)) handler(value)
    }
  }
}

/** What a web worker's `error` event says; stringifying one gives `[object ErrorEvent]`. */
function describe(event: ErrorEvent): string {
  if (!event.message) return String(event.error ?? event)
  return event.message + (event.filename ? ` (${event.filename}:${event.lineno})` : '')
}

async function startWorker(url: URL): Promise<Spare> {
  const messages = channel<FromThread>()
  const errors = channel<unknown>()
  const exits = channel<number>()
  const listeners = {
    onMessage: (handler: (message: FromThread) => void) => messages.listen(handler),
    onError: (handler: (error: unknown) => void) => errors.listen(handler),
    onExit: (handler: (code: number) => void) => exits.listen(handler)
  }

  if (WebWorker) {
    const worker = new WebWorker(url, { type: 'module' })
    worker.addEventListener('message', event => messages.emit(event.data))
    worker.addEventListener('error', event => errors.emit(describe(event)))
    return {
      host: { post: message => worker.postMessage(message), terminate: () => worker.terminate(), ...listeners },
      take: () => {}
    }
  }

  const { Worker: NodeWorker } = await import(/* @vite-ignore */ nodeWorkerThreads) as typeof import('node:worker_threads')
  const worker = new NodeWorker(url)
  worker.on('message', message => messages.emit(message))
  worker.on('error', error => errors.emit(error))
  worker.on('exit', code => exits.emit(code))
  // A spare waits for a program, which is no reason to keep Node running
  worker.unref()
  return {
    host: { post: message => worker.postMessage(message), terminate: () => void worker.terminate(), ...listeners },
    take: () => worker.ref()
  }
}

function interpreterFor(bytes: Uint8Array): Interpreter {
  const index = interpreters.findIndex(entry => sameBytes(entry.bytes, bytes))
  if (index >= 0) {
    const [entry] = interpreters.splice(index, 1)
    interpreters.unshift(entry!)
    return entry!
  }

  const entry: Interpreter = { bytes: bytes.slice(), url: urlFor(bytes), spares: [] }
  interpreters.unshift(entry)
  for (const old of interpreters.splice(MAX_INTERPRETERS)) {
    for (const spare of old.spares) void spare.then(({ host }) => host.terminate(), () => {})
    if (old.url.protocol === 'blob:') URL.revokeObjectURL(old.url.href)
  }
  return entry
}

async function warmThread(bytes: Uint8Array): Promise<HostThread> {
  const entry = interpreterFor(bytes)
  const spare = entry.spares.shift() ?? startWorker(entry.url)
  // The next programs of this interpreter get workers started now
  while (entry.spares.length < SPARES) {
    const next = startWorker(entry.url)
    entry.spares.push(next)
    next.catch(() => { entry.spares = entry.spares.filter(other => other !== next) })
  }
  const taken = await spare
  taken.take()
  const host = taken.host
  const post = host.post.bind(host)
  host.post = message => {
    const exe = (message as { $?: string }).$ === 'init' ? (message as unknown as { exe?: string }).exe : undefined
    const program = exe === undefined ? undefined : programs.get(exe)
    // a message of its own, before `init`: the worker holds it until it knows which program it was started for
    if (exe !== undefined && program) post({ $: 'wali-module', exe, ...program } as never)
    post(message)
  }
  return host
}

/** Idempotent. */
export function installWarmThreads(): void {
  if (installed) return
  installed = true
  set_thread_factory(warmThread)
}
