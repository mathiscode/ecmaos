import path from 'path'
import { Fetch, InMemory, resolveMountConfig, SingleBuffer } from '@zenfs/core'
import { IndexedDB, WebStorage, WebAccess } from '@zenfs/dom'

import { FsError, PeerError } from '@ecmaos/peer'
import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { FsMountRequest, FsType } from './fs-types.ts'
import type { Outcome, OutcomeLine } from './outcome.ts'
import { heldBy, heldInMemory, totalHeld } from './memory-usage.ts'
import { currentStorageLimits, formatBytes } from './storage-limits.ts'
import { DefaultLimits, openRemoteFs, parseRemoteSource, parseSize, RemoteMountFailure } from './remote-mount.ts'

/**
 * Everything `mount` needs that only the main thread has: the live mount table, browser storage and File System
 * Access APIs, and Google's OAuth scripts. The `mount` program parses arguments and calls this through `fs_mount`.
 * Results are lines to print (`{ stream, text }`) plus an exit code.
 */

const MiB = 1024 * 1024

export interface MountRequest {
  type: string
  source: string
  /** Resolved against `cwd` */
  target: string
  cwd: string
  options: Record<string, string>
  /** False for `/etc/fstab` processing: backends needing a picker or OAuth sign-in are skipped */
  interactive: boolean
}


/**
 * A failure with a message ready to show as `mount: <message>`; anything else is wrapped as "failed to mount
 * filesystem"
 */
class MountFailure extends Error {}

const isUrl = (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)

export function listMounts(kernel: Kernel): Array<{ target: string, name: string }> {
  return Array.from(kernel.filesystem.mounts.entries()).map(([target, mount]: [string, unknown]) => {
    const mountObj = mount as { store?: { constructor?: { name?: string } }, constructor?: { name?: string }, metadata?: () => { name?: string } }
    const backendName = mountObj.store?.constructor?.name || mountObj.constructor?.name || 'Unknown'
    return { target, name: mountObj.metadata?.()?.name || backendName }
  })
}

/** The types that are part of the kernel; `kernel.fstypes` registers them at boot, and a module adds more beside them */
export function builtinFsTypes(): FsType[] {
  return [
    {
      name: 'fetch',
      source: 'optional',
      async mount(request: FsMountRequest) {
        let baseUrl = request.options.baseUrl || ''
        let indexUrl: string
        if (request.source && isUrl(request.source)) {
          indexUrl = request.source
        } else {
          if (!baseUrl) request.fail('fetch filesystem requires either a full URL as source or baseUrl option')
          baseUrl = new URL(baseUrl).toString()
          indexUrl = new URL(request.source || 'index.json', baseUrl).toString()
        }
        await request.mount({ backend: Fetch, index: indexUrl, baseUrl, disableAsyncCache: true })
      }
    },
    {
      name: 'indexeddb',
      source: 'optional',
      mount: request => request.mount({ backend: IndexedDB, storeName: request.source || request.target })
    },
    {
      name: 'webstorage',
      source: 'none',
      async mount(request: FsMountRequest) {
        const storageType = request.options.storage?.toLowerCase() || 'localstorage'
        let storage: Storage
        if (storageType === 'sessionstorage') {
          if (typeof sessionStorage === 'undefined') request.fail('sessionStorage is not available in this environment')
          storage = sessionStorage
        } else if (storageType === 'localstorage') {
          if (typeof localStorage === 'undefined') request.fail('localStorage is not available in this environment')
          storage = localStorage
        } else {
          request.fail(`invalid storage type '${storageType}'. Use 'localStorage' or 'sessionStorage'`)
        }
        await request.mount({ backend: WebStorage, storage })
      }
    },
    {
      name: 'webaccess',
      source: 'none',
      needsPerson: 'webaccess requires interactive directory selection',
      async mount(request: FsMountRequest) {
        const win = (typeof window === 'undefined' ? undefined : window) as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> } | undefined
        if (!win?.showDirectoryPicker) request.fail('File System Access API is not available in this environment')
        let handle: FileSystemDirectoryHandle
        try {
          handle = await win.showDirectoryPicker()
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') request.fail('directory selection cancelled')
          throw error
        }
        await request.mount({ backend: WebAccess, handle })
      }
    },
    {
      name: 'opfs',
      source: 'none',
      async mount(request: FsMountRequest) {
        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) request.fail('Origin Private File System is not available in this environment')
        await request.mount({ backend: WebAccess, handle: await navigator.storage.getDirectory() })
      }
    },
    {
      name: 'memory',
      source: 'none',
      mount: request => request.mount({ backend: InMemory })
    },
    {
      // Linux's name for the same thing, which is what /proc/mounts already calls the root and /tmp
      name: 'tmpfs',
      source: 'none',
      mount: request => request.mount({ backend: InMemory })
    },
    {
      name: 'singlebuffer',
      source: 'none',
      async mount(request: FsMountRequest) {
        const size = request.options.size ? parseInt(request.options.size, 10) : 1048576
        if (isNaN(size) || size <= 0) request.fail('invalid buffer size for singlebuffer type')
        let buffer: ArrayBuffer | SharedArrayBuffer
        try { buffer = new SharedArrayBuffer(size) } catch { buffer = new ArrayBuffer(size) }
        await request.mount({ backend: SingleBuffer, buffer })
      }
    },
    {
      name: 'ecmaos',
      source: 'required',
      async mount(request: FsMountRequest) {
        const { kernel, shell, target, options: mountOptions } = request
        // The password unlocks the key that signs the login; a mount from /etc/fstab has nobody to ask
        if (!request.interactive || !mountOptions.password) request.fail(`skipping ${target}: ecmaos asks for the password of the account whose key logs in`)
        const parsed = request.source ? parseRemoteSource(request.source, shell.env.get('USER') || 'root') : null
        if (!parsed) request.fail('ecmaos filesystem needs a source: [user@]host[:port][/export]')
        const maxfiles = mountOptions.maxfiles ? Number(mountOptions.maxfiles) : DefaultLimits.files
        const maxsize = mountOptions.maxsize ? parseSize(mountOptions.maxsize) : DefaultLimits.bytes
        if (!Number.isInteger(maxfiles) || maxfiles <= 0 || !maxsize) request.fail('maxfiles must be a number and maxsize a size such as 50M')
        const uid = mountOptions.uid ? Number(mountOptions.uid) : 0
        const gid = mountOptions.gid ? Number(mountOptions.gid) : uid
        if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) request.fail('uid and gid must be numbers')
        try {
          const remote = await openRemoteFs(kernel, shell, {
            source: parsed,
            password: mountOptions.password,
            pairingCode: mountOptions.pair,
            fingerprint: mountOptions.fingerprint,
            acceptNew: mountOptions['accept-new'] === 'yes' || mountOptions['accept-new'] === 'true',
            limits: { files: maxfiles, bytes: maxsize },
            owner: { uid, gid },
            onError: (operation, where, error) => kernel.log.warn(`${target}: ${operation} ${where} failed on the other machine: ${error instanceof Error ? error.message : String(error)}`)
          })
          await kernel.filesystem.fsSync.mount(target, remote)
          request.out(`Mounted ${parsed.user}@${parsed.host}:${parsed.port}/${parsed.name} at ${target}`)
        } catch (error) {
          if (error instanceof RemoteMountFailure) request.fail(error.message)
          if (error instanceof PeerError || error instanceof FsError || (error instanceof Error && 'code' in error)) request.fail(error.message)
          throw error
        }
        return true
      }
    }
  ]
}

export async function mountFilesystem(kernel: Kernel, shell: Shell, request: MountRequest): Promise<Outcome> {
  const lines: OutcomeLine[] = []
  const out = (text: string) => lines.push({ stream: 'out', text })
  const err = (text: string) => lines.push({ stream: 'err', text })

  const source = request.source
  const target = path.resolve(request.cwd, request.target)
  const fs = shell.context.fs.promises

  try {
    // a type nobody has is asked for by name, as Linux's `mount` does: `-t zip` calls for the module with alias `fs-zip`
    let type = kernel.fstypes.get(request.type)
    if (!type && await kernel.requestModule(`fs-${request.type.toLowerCase()}`)) type = kernel.fstypes.get(request.type)
    if (!type) throw new MountFailure(`unknown filesystem type '${request.type}'\nSupported types: ${kernel.fstypes.names().join(', ')}`)
    if (!request.interactive && type.needsPerson) throw new MountFailure(`skipping ${target}: ${type.needsPerson}`)
    if (type.source === 'required' && !source) throw new MountFailure(`${type.name} filesystem requires a source`)
    if (type.source === 'none' && source) throw new MountFailure(`${type.name} filesystem does not require a source`)

    const parentDir = path.dirname(target)
    if (parentDir !== target && !(await fs.exists(parentDir))) await fs.mkdir(parentDir, { recursive: true })
    if (!(await fs.exists(target))) await fs.mkdir(target, { recursive: true })

    const mount = async (config: unknown) => {
      const mounted = await resolveMountConfig(config as never)
      await kernel.filesystem.fsSync.mount(target, mounted)
      kernel.fstypes.track(type.name, mounted)
      // Some backends (OPFS, a directory handle, a cloud drive) copy what they mount into memory: say so, since it is
      // RAM the machine now holds
      const held = heldBy(kernel.filesystem.mounts.get(target))
      if (held && held.bytes >= MiB) {
        out(`${target} holds ${formatBytes(held.bytes)} in memory (${held.kind === 'directory-cache' ? 'the directory is cached whole' : 'a memory file system'}); see df`)
        const total = totalHeld(heldInMemory(kernel.filesystem.mounts.entries()))
        const warnAt = currentStorageLimits().warnResidentBytes
        if (warnAt !== false && total >= warnAt) out(`warning: the machine now holds ${formatBytes(total)} in memory (warning at ${formatBytes(warnAt)})`)
      }
    }

    const reported = await type.mount({
      type: request.type,
      source,
      target,
      cwd: request.cwd,
      options: request.options,
      interactive: request.interactive,
      kernel,
      shell,
      mount,
      out,
      fail: (message: string): never => { throw new MountFailure(message) },
      read: async (from: string) => {
        if (isUrl(from)) {
          const response = await fetch(from)
          if (!response.ok) throw new MountFailure(`failed to fetch ${from}: ${response.status} ${response.statusText}`)
          return new Uint8Array(await response.arrayBuffer())
        }
        const file = path.resolve(request.cwd, from)
        if (!(await fs.exists(file))) throw new MountFailure(`file not found: ${file}`)
        return new Uint8Array(await fs.readFile(file))
      }
    })
    if (reported) return { code: 0, lines }

    out(source && type.source !== 'none' ? `Mounted ${request.type} filesystem from ${source} to ${target}` : `Mounted ${request.type} filesystem at ${target}`)
    return { code: 0, lines }
  } catch (error) {
    if (error instanceof MountFailure) {
      for (const [index, text] of error.message.split('\n').entries()) err(index === 0 ? `mount: ${text}` : text)
    } else {
      err(`mount: failed to mount filesystem: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
    return { code: 1, lines }
  }
}
