/**
 * Manifest-declared syscall allowlists for programs run through `/bin/node`. A program may ship a sibling
 * `<program>.manifest.json`:
 * ```json
 * { "syscalls": ["read", "write", "openat", "close", "exit_group"], "devices": ["tty", "echo"] }
 * ```
 * Any syscall it does not list is refused with `-EPERM` by a wrapper around every entry in `@zenfs/linux`'s
 * `syscalls` table. A program with no manifest is unrestricted.
 * `devices` is enforced in `Kernel.registerDevices`'s per-major dispatch, which cannot `await loadManifest`; it reads
 * the cache synchronously through {@link getCachedManifest}, populated by the syscall that opened the device node.
 */

import { syscalls } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'
import { Errno } from 'kerium'
import type { Filesystem } from '@ecmaos/types'

export interface ProgramManifest {
  /** Syscall names (as userspace calls them, e.g. "openat", "read") this program may use. */
  syscalls?: string[]
  /**
   * Device classes/names this program may open, checked against a device's `name`/`class` at
   * `Kernel.registerDevices`'s dispatch - see module docs.
   */
  devices?: string[]
}

const manifestCache = new Map<string, ProgramManifest | null>()
/** Handlers this module has already wrapped, so a repeat call doesn't double-wrap them. */
const wrappedHandlers = new WeakSet<object>()

function manifestPathFor(exe: string): string {
  return `${exe}.manifest.json`
}

async function loadManifest(fs: Filesystem['fs'], exe: string): Promise<ProgramManifest | null> {
  if (manifestCache.has(exe)) return manifestCache.get(exe)!

  const manifestPath = manifestPathFor(exe)
  let manifest: ProgramManifest | null = null

  try {
    if (await fs.exists(manifestPath)) {
      const raw = await fs.readFile(manifestPath, 'utf-8')
      const parsed = JSON.parse(raw) as ProgramManifest
      manifest = {
        syscalls: Array.isArray(parsed.syscalls) ? parsed.syscalls : undefined,
        devices: Array.isArray(parsed.devices) ? parsed.devices : undefined
      }
    }
  } catch {
    // A malformed manifest is treated as "no manifest" rather than a boot-time failure -
    // the program still runs unrestricted, same as if the file didn't exist.
    manifest = null
  }

  manifestCache.set(exe, manifest)
  return manifest
}

/** Drop a cached manifest, e.g. after the manifest file on disk changes. */
export function invalidateManifestCache(exe?: string): void {
  if (exe) manifestCache.delete(exe)
  else manifestCache.clear()
}

/**
 * Reads the manifest cache synchronously. `undefined` means not cached yet, `null` means checked and none exists;
 * callers treat both as unrestricted.
 */
export function getCachedManifest(exe: string): ProgramManifest | null | undefined {
  return manifestCache.get(exe)
}

/**
 * Wrap every syscall handler currently registered in `@zenfs/linux`'s table with a manifest
 * check. Safe to call more than once (e.g. after a later `define_syscall` registers something
 * new) - already-wrapped handlers are tracked and skipped, so nothing is wrapped twice.
 */
/** What a policy added by a module is told of each syscall */
export interface PolicyCall {
  syscall: string
  pid: number
  uid: number
  exe?: string
}

/** Checks added by modules (`ctx.syscallPolicy`): a syscall any of them answers `false` to is refused, whatever a manifest says */
const policies = new Set<(call: PolicyCall) => boolean | void>()

/** Adds a check to every syscall and returns the function that takes it away */
export function addSyscallPolicy(policy: (call: PolicyCall) => boolean | void): () => void {
  policies.add(policy)
  return () => { policies.delete(policy) }
}

export function installSyscallPolicy(fs: Filesystem['fs']): void {
  for (const [name, handler] of syscalls.entries()) {
    if (wrappedHandlers.has(handler as object)) continue

    const wrapped = async (proc: Process, ...args: unknown[]): Promise<number | bigint | void> => {
      if (policies.size) {
        const call: PolicyCall = { syscall: name as string, pid: proc.pid, uid: proc.context.credentials.euid, exe: proc.exe }
        for (const policy of policies) if (policy(call) === false) return -Errno.EPERM
      }

      const exe = proc.exe
      if (exe) {
        const manifest = await loadManifest(fs, exe)
        if (manifest?.syscalls && !manifest.syscalls.includes(name as string)) {
          return -Errno.EPERM
        }
      }

      return (handler as (proc: Process, ...args: unknown[]) => number | bigint | void | Promise<number | bigint | void>)(proc, ...args)
    }

    wrappedHandlers.add(wrapped)
    syscalls.set(name, wrapped as typeof handler)
  }
}
