import * as cli from '@bytecodealliance/preview2-shim/cli'
import * as clocks from '@bytecodealliance/preview2-shim/clocks'
import * as filesystem from '@bytecodealliance/preview2-shim/filesystem'
import * as io from '@bytecodealliance/preview2-shim/io'
import type { InputStreamHandler } from '@bytecodealliance/preview2-shim/io'
import * as random from '@bytecodealliance/preview2-shim/random'
import * as sockets from '@bytecodealliance/preview2-shim/sockets'
import type { Kernel, Shell, WasiStreamOptions } from '@ecmaos/types'

interface WasiComponentResult {
  instance: WebAssembly.Instance
  exitCode: Promise<number>
}

/** A WASI stream that has ended, as `wasi:io/streams` reports it */
const closed = () => { throw { tag: 'closed' } }

/**
 * With JSPI (`WebAssembly.Suspending`) a component's blocking reads and flushes wait on the kernel's streams; without
 * it a call into the host has to answer at once, so stdin is read to its end before the program starts.
 */
const jspi = () => typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function'

const ASYNC_IMPORTS = [
  'wasi:io/streams#[method]input-stream.blocking-read',
  'wasi:io/streams#[method]output-stream.blocking-flush',
  'wasi:io/streams#[method]output-stream.blocking-write-and-flush'
]
const ASYNC_EXPORTS = ['wasi:cli/run#run']

/**
 * Runs a WASI Preview 2 component: jco transpiles it to core modules and the JS that joins them, and it runs on the
 * main thread against preview2-shim's browser interfaces, with stdio on the kernel's streams and the shell's
 * arguments, environment and working directory. It has no filesystem (no preopens) and no network.
 */
export default async function createWasiPreview2Bindings({
  kernel,
  streams,
  args,
  shell,
  wasmBytes,
}: {
  kernel: Kernel,
  streams: WasiStreamOptions,
  args: string[],
  shell: Shell,
  wasmBytes: Uint8Array
}): Promise<WasiComponentResult> {
  const suspending = jspi()
  // jco's component bindgen itself, the same API in a page and in Node (the package's `transpile` differs between the two)
  const { generate } = await import('@bytecodealliance/jco/component')
  const { files } = await generate(wasmBytes, {
    name: 'component',
    instantiation: { tag: 'async' },
    noTypescript: true,
    asyncMode: suspending ? { tag: 'jspi', val: { imports: ASYNC_IMPORTS, exports: ASYNC_EXPORTS } } : { tag: 'sync' }
  })
  const output = new Map<string, Uint8Array>(files)
  const js = output.get('component.js')
  if (!js) throw new Error('jco produced no component.js')

  // In instantiation mode the module imports nothing it uses, so a data: URL loads it in a page and in Node alike. Its
  // runner waits on what it yields only when it is `instanceof Promise`, which the browser's own promises are not once
  // zone.js (OpenTelemetry's context manager) has replaced the global Promise; it waits on any thenable instead.
  const runner = 'while (!(value instanceof Promise) && !done);'
  const source = new TextDecoder().decode(js).replaceAll(runner, "while (!(value && typeof value.then === 'function') && !done);")
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${base64(source)}`) as {
    instantiate: (getCoreModule: (name: string) => Promise<WebAssembly.Module>, imports: Record<string, unknown>) => Promise<Record<string, unknown>>
  }

  const stdin = streams.stdin.getReader()
  const stdout = streams.stdout.getWriter()
  const stderr = streams.stderr.getWriter()

  // stdin: what has been read from the stream and not yet taken by the program
  let pending = new Uint8Array(0)
  let ended = false
  const take = (len: bigint) => {
    const count = Math.min(Number(len), pending.byteLength)
    const bytes = pending.slice(0, count)
    pending = pending.subarray(count)
    return bytes
  }
  const fill = async () => {
    const { done, value } = await stdin.read().catch(() => ({ done: true, value: undefined }))
    if (done) ended = true
    else if (value?.byteLength) pending = concat(pending, value)
  }
  if (!suspending) while (!ended) await fill()

  // under JSPI a blocking read may return a promise, which the shim's types (written for synchronous hosts) do not allow
  const input = {
    blockingRead: suspending
      ? async (len: bigint) => {
        while (!pending.byteLength && !ended) await fill()
        if (!pending.byteLength) closed()
        return take(len)
      }
      : (len: bigint) => {
        if (!pending.byteLength) closed()
        return take(len)
      },
    read(len: bigint) {
      if (!pending.byteLength && ended) closed()
      return take(len)
    },
    subscribe: () => io.pollableCreate()
  } as unknown as InputStreamHandler

  // stdout and stderr: each write is queued on the stream's writer in order, and a flush waits for the queue when it can
  const queuedOutput = (writer: WritableStreamDefaultWriter<Uint8Array>) => {
    let queue: Promise<void> = Promise.resolve()
    // copied at once: the bytes are a view of the program's memory, which it reuses
    const write = (contents: Uint8Array) => {
      const bytes = contents.slice()
      queue = queue.then(() => writer.write(bytes)).catch(() => {})
    }
    return {
      queue: () => queue,
      handler: {
        write,
        flush() {},
        blockingFlush: suspending ? () => queue : () => {},
        blockingWriteAndFlush: suspending ? (contents: Uint8Array) => { write(contents); return queue } : write
      }
    }
  }
  const out = queuedOutput(stdout)
  const err = queuedOutput(stderr)

  const environment: Record<string, string> = {}
  for (const [key, value] of (shell || kernel.shell)?.env?.entries() ?? []) environment[key] = value
  const shim = cli.createCli({
    arguments: args,
    environment,
    initialCwd: (shell || kernel.shell)?.cwd ?? '/',
    stdin: input,
    stdout: out.handler,
    stderr: err.handler
  })
  const fs = filesystem.createFilesystem({ adapter: { getRoot: () => { throw new Error('no preopens') } }, preopens: {} })

  const imports: Record<string, unknown> = {
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
    'wasi:filesystem/preopens': fs.preopens,
    'wasi:filesystem/types': fs.types,
    'wasi:io/error': io.error,
    'wasi:io/poll': io.poll,
    'wasi:io/streams': io.streams,
    'wasi:random/random': random.random,
    'wasi:random/insecure': random.insecure,
    'wasi:random/insecure-seed': random.insecureSeed,
    'wasi:sockets/instance-network': sockets.instanceNetwork,
    'wasi:sockets/ip-name-lookup': sockets.ipNameLookup,
    'wasi:sockets/network': sockets.network,
    'wasi:sockets/tcp': sockets.tcp,
    'wasi:sockets/tcp-create-socket': sockets.tcpCreateSocket,
    'wasi:sockets/udp': sockets.udp,
    'wasi:sockets/udp-create-socket': sockets.udpCreateSocket
  }

  const getCoreModule = async (name: string) => {
    const bytes = output.get(name)
    if (!bytes) throw new Error(`jco produced no ${name}`)
    return WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>)
  }

  const finish = async () => {
    await Promise.all([out.queue(), err.queue()])
    for (const lock of [stdin, stdout, stderr]) {
      try { lock.releaseLock() } catch { /* already released */ }
    }
  }

  let component: Record<string, unknown>
  try {
    component = await module.instantiate(getCoreModule, imports)
  } catch (error) {
    await finish()
    throw error
  }

  const run = (component['wasi:cli/run'] ?? component['run']) as { run?: () => unknown } | undefined
  if (typeof run?.run !== 'function') {
    await finish()
    throw new Error('the component exports no wasi:cli/run')
  }

  const exitCode = (async () => {
    try {
      await run.run!()
      return 0
    } catch (error) {
      // wasi:cli/exit throws to unwind the program; anything else is a trap or a bug in the program
      if (error && typeof error === 'object' && 'exitError' in error) return Number((error as { code?: number }).code ?? 1)
      // run's result<_, _> comes back as a thrown { tag: 'err' } from the transpiled export
      if (error && typeof error === 'object' && 'tag' in error && (error as { tag: string }).tag === 'err') return 1
      const message = error instanceof Error ? error.message : String(error)
      err.handler.write(new TextEncoder().encode(`${args[0] ?? 'component'}: ${message}\n`))
      return 1
    } finally {
      await finish()
    }
  })()

  return { instance: { exports: component as WebAssembly.Exports } as WebAssembly.Instance, exitCode }
}

function concat(a: Uint8Array, b: Uint8Array) {
  const joined = new Uint8Array(a.byteLength + b.byteLength)
  joined.set(a)
  joined.set(b, a.byteLength)
  return joined
}

function base64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
