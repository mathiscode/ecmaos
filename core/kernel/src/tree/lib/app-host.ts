import path from 'path'

import { bindContext } from '@zenfs/core'
import type { Process } from '@zenfs/linux'

import type { AppLaunch, WindowHandle } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

/** The largest file an app may read in one call; bigger would not fit one message to the display */
const MaxRead = 32 * 1024 * 1024
/** The largest piece of data in one write: the SDK sends 32 KiB at a time */
const MaxWrite = 256 * 1024

const isBytes = (value: unknown): value is { $bytes: string } => !!value && typeof value === 'object' && typeof (value as { $bytes?: unknown }).$bytes === 'string'

const bytesOf = (value: unknown): Uint8Array => {
  if (!isBytes(value)) throw new Error('expected bytes')
  const binary = atob(value.$bytes)
  if (binary.length > MaxWrite) throw new Error(`a write is limited to ${MaxWrite} bytes at a time`)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

const encodeBytes = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return { $bytes: btoa(binary) }
}

const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a path`)
  return value
}

export interface ServedApp {
  /** Resolves to the app's exit code when it exits, fails, or its window closes */
  closed: Promise<number>
  /** Ends the app and closes its window (the process was killed) */
  dispose(): void
}

/**
 * Answers the calls an app makes from its window's sandbox (`AppSdk`). It acts as the process that started the app: files
 * are read and written with that process's credentials, so the permission checks are the ones that process is under. The
 * app can do nothing that is not an operation below.
 */
export function serveApp(kernel: Kernel, proc: Process, win: WindowHandle, launch: AppLaunch): ServedApp {
  // the process's own credentials and root: every call is checked as that process would be
  const fs = bindContext.call(proc.context, { pwd: launch.cwd, credentials: proc.context.credentials }).fs.promises
  const resolve = (value: unknown, name = 'path') => path.resolve(launch.cwd, text(value, name))
  let finish!: (code: number) => void
  const closed = new Promise<number>(done => { finish = done })

  const operations: Record<string, (...args: unknown[]) => Promise<unknown> | unknown> = {
    'fs.readFile': async file => {
      const target = resolve(file)
      const { size } = await fs.stat(target)
      if (size > MaxRead) throw new Error(`${target} is larger than ${MaxRead} bytes`)
      return encodeBytes(new Uint8Array(await fs.readFile(target)))
    },
    'fs.writeFile': (file, data) => fs.writeFile(resolve(file), bytesOf(data)),
    'fs.appendFile': (file, data) => fs.appendFile(resolve(file), bytesOf(data)),
    'fs.mkdir': async (file, options) => { await fs.mkdir(resolve(file), { recursive: !!(options as { recursive?: boolean } | undefined)?.recursive }) },
    'fs.readdir': async file => (await fs.readdir(resolve(file))).map(String),
    'fs.stat': async file => {
      const stats = await fs.stat(resolve(file))
      return { size: stats.size, mode: stats.mode, mtimeMs: stats.mtimeMs, isFile: stats.isFile(), isDirectory: stats.isDirectory(), isSymbolicLink: stats.isSymbolicLink() }
    },
    'fs.access': file => fs.access(resolve(file)),
    'fs.unlink': file => fs.unlink(resolve(file)),
    'fs.rename': (from, to) => fs.rename(resolve(from, 'from'), resolve(to, 'to')),
    'window.setTitle': title => { win.setTitle(String(title)) },
    'window.close': () => { win.close(true) },
    log: message => { kernel.log.info(`${launch.command}[${launch.pid}]: ${String(message)}`) },
    exit: code => { kernel.log.info(`${launch.command}[${launch.pid}]: exit ${String(code)}`); finish(typeof code === 'number' ? code : 0); win.close(true) },
    fail: message => { kernel.log.error(`${launch.command}[${launch.pid}]: ${String(message)}`); finish(1); win.close(true) }
  }

  win.onCall(async (op, args) => {
    const operation = Object.hasOwn(operations, op) ? operations[op] : undefined
    if (!operation) throw new Error(`unknown call: ${op}`)
    return (await operation(...args)) ?? null
  })
  const unsubscribe = kernel.windows.on('close', info => {
    if (info.id !== win.id) return
    unsubscribe()
    finish(0)
  })
  return { closed, dispose: () => { win.close(true) } }
}
