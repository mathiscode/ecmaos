/**
 * Manifest-declared syscall allowlists for programs run through `/bin/node`.
 *
 * A program at `/path/to/program` may ship a sibling `/path/to/program.manifest.json`:
 * ```json
 * { "syscalls": ["read", "write", "openat", "close", "exit_group"], "devices": ["tty", "echo"] }
 * ```
 * When present, any syscall it does not list is refused with `-EPERM` before the real handler
 * ever runs -- this is enforced centrally, by wrapping every entry registered in `@zenfs/linux`'s
 * `syscalls` table, not by trusting each handler to check for itself. A program with no manifest
 * is unrestricted (today's behavior), so existing scripts/apps/commands keep working; the
 * allowlist is opt-in per-program until manifests are the norm.
 *
 * `devices` is enforced at a separate chokepoint (`Kernel.registerDevices`'s per-major dispatch,
 * `core/kernel/src/tree/kernel.ts`), not here -- `char_dev`/`block_dev` `FileOperations.read`/
 * `write` are called synchronously (`devtmpfs.js` never awaits them, even from its own `async`
 * entry points), so they can't `await loadManifest` themselves the way a syscall handler can.
 * Instead, {@link getCachedManifest} exposes this module's manifest cache synchronously: by the
 * time a process reaches a device's `read`/`write`, it has necessarily already made at least one
 * syscall (to open the device node in the first place), which `installSyscallPolicy` intercepts
 * and which populates this cache as a side effect -- so the manifest is reliably already cached,
 * not fetched fresh, at the point device dispatch needs it.
 */

import { syscalls } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'
import { Errno } from 'kerium'
import type { Filesystem } from '@ecmaos/types'

export interface ProgramManifest {
  /** Syscall names (as userspace calls them, e.g. "openat", "read") this program may use. */
  syscalls?: string[]
  /** Device classes/names this program may open, checked against a device's `name`/`class` at `Kernel.registerDevices`'s dispatch -- see module docs. */
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
    // A malformed manifest is treated as "no manifest" rather than a boot-time failure --
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
 * Synchronously read this module's manifest cache, for a caller (device dispatch) that can't
 * `await loadManifest` itself. `undefined` means "not cached yet" (no syscall has run for this
 * `exe` yet, or the cache was cleared) -- distinct from `null`, which means "checked, no manifest
 * exists." A caller should treat `undefined` the same as `null` (unrestricted), the same
 * fail-open default `installSyscallPolicy` itself uses for an unrecognized program.
 */
export function getCachedManifest(exe: string): ProgramManifest | null | undefined {
  return manifestCache.get(exe)
}

/**
 * Wrap every syscall handler currently registered in `@zenfs/linux`'s table with a manifest
 * check. Safe to call more than once (e.g. after a later `define_syscall` registers something
 * new) -- already-wrapped handlers are tracked and skipped, so nothing is wrapped twice.
 */
export function installSyscallPolicy(fs: Filesystem['fs']): void {
  for (const [name, handler] of syscalls.entries()) {
    if (wrappedHandlers.has(handler as object)) continue

    const wrapped = async (proc: Process, ...args: unknown[]): Promise<number | bigint | void> => {
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
