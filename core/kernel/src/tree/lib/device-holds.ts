/**
 * `@zenfs/linux` never calls a device's `open` and `release`, since `@zenfs/core` has no hook for opening a file. Programs
 * reach devices through the `open`, `close` and `dup2` syscalls and end by exiting, so those are wrapped: after each, the
 * descriptors of every process are counted per device, and a device that went from none to some is told `open`, and one that
 * went from some to none `release`. Like Linux, the driver sees one open for the first descriptor and one release for the last,
 * however many descriptors (dup, fork) there are in between.
 *
 * Code that reads the file system object directly (the kernel's own `fs`) has no descriptor in any process; session nodes serve
 * those by opening on first use (see `sessionOperations`).
 */

import { Process, processes, syscalls } from '@zenfs/linux'
import type { FileOperations } from '@zenfs/linux'

const S_IFMT = 0o170000
const S_IFCHR = 0o020000

/** The operations registered for each character device major; a major is claimed once per realm, as in `@zenfs/linux` */
const registered = new Map<number, FileOperations>()
/** Devices that have been told `open`, by `major:minor`, with the numbers to hand to `release` */
const held = new Map<string, { major: number, minor: number, path: string, inode: unknown }>()
let installed = false

export function registerHeldOperations(major: number, ops: FileOperations): void {
  if (!registered.has(major)) registered.set(major, ops)
}

type Handle = { inode?: { mode: number, rdev?: number | bigint }, internalPath?: string, path?: string }

/** The character devices that some process has a descriptor on */
function openDevices(): Map<string, { major: number, minor: number, path: string, inode: unknown }> {
  const found = new Map<string, { major: number, minor: number, path: string, inode: unknown }>()
  for (const proc of processes.values()) {
    for (const entry of proc.context.descriptors.values()) {
      const handle = entry as unknown as Handle
      let inode: Handle['inode']
      try { inode = handle.inode } catch { continue }
      if (!inode || (inode.mode & S_IFMT) !== S_IFCHR) continue
      const rdev = BigInt(inode.rdev ?? 0)
      const major = Number(rdev >> 20n)
      const minor = Number(rdev & 0xfffffn)
      if (!registered.has(major)) continue
      const key = `${major}:${minor}`
      if (!found.has(key)) found.set(key, { major, minor, path: handle.internalPath ?? handle.path ?? '', inode })
    }
  }
  return found
}

/** Tells devices their first open and last release, from the descriptors that exist now */
export function sweepDevices(): void {
  const now = openDevices()
  for (const [key, device] of now) {
    if (held.has(key)) continue
    held.set(key, device)
    try { registered.get(device.major)?.open?.({ path: device.path, inode: device.inode, devt: { major: device.major, minor: device.minor } } as never) } catch { /* the driver refused; reads and writes will say why */ }
  }
  for (const [key, device] of [...held]) {
    if (now.has(key)) continue
    held.delete(key)
    try { registered.get(device.major)?.release?.({ path: device.path, inode: device.inode, devt: { major: device.major, minor: device.minor } } as never) } catch { /* already gone */ }
  }
}

type Handler = (proc: Process, ...args: unknown[]) => number | bigint | void | Promise<number | bigint | void>

/** Wraps `open`, `close`, `dup2`, `dup3` and process exit. Idempotent. */
export function installDeviceHolds(): void {
  if (installed) return
  installed = true

  for (const name of ['open', 'close', 'dup2', 'dup3'] as const) {
    const original = syscalls.get(name as never) as Handler | undefined
    if (!original) continue
    syscalls.set(name as never, (async (proc: Process, ...args: unknown[]) => {
      try { return await original(proc, ...args) } finally { sweepDevices() }
    }) as never)
  }

  const exit = Process.prototype.exit
  Process.prototype.exit = function (this: Process, ...args: Parameters<typeof exit>) {
    try { return exit.apply(this, args) } finally { sweepDevices() }
  }
}
