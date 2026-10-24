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

import { DevTmpFS, Process, processes, syscalls } from '@zenfs/linux'
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

/**
 * Nodes taken away (a device unplugged) while a descriptor was still open on them, by their path in devtmpfs, with the inode
 * they had. `@zenfs/linux` finds a descriptor's device by its path, so without this the descriptor would get `ENOENT`; on
 * Linux an open file keeps its inode and so its driver, which says what it likes (a hung-up tty the end of the file, an input
 * device `ENODEV`). Forgotten at the last close, or when a new node takes the path.
 */
const unlinked = new Map<string, unknown>()

/** Tells devices their first open and last release, from the descriptors that exist now */
export function sweepDevices(): void {
  const now = openDevices()
  const paths = new Set([...now.values()].map(device => device.path))
  for (const path of unlinked.keys()) if (!paths.has(path)) unlinked.delete(path)
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

/** Wraps `open`, `close`, `dup2`, `dup3` and process exit, and keeps removed nodes reachable from their descriptors. Idempotent. */
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

  // `/dev/null` ends at once. Its upstream `read` returns nothing, which the file system layer reports as the whole length asked
  // for, so a program that reads it to the end would be handed zeros for ever.
  const read = syscalls.get('read' as never) as Handler | undefined
  if (read) {
    const NullDevice = (1n << 20n) | 3n
    syscalls.set('read' as never, (async (proc: Process, fd: unknown, ...args: unknown[]) => {
      try {
        const handle = proc.context.descriptors.get(fd as number) as unknown as Handle | undefined
        const inode = handle?.inode
        if (inode && (inode.mode & S_IFMT) === S_IFCHR && BigInt(inode.rdev ?? 0) === NullDevice) return 0
      } catch { /* not a descriptor that can be told apart; the real read says what is wrong */ }
      return await read(proc, fd, ...args)
    }) as never)
  }

  type Node = { dev_node(): { name: string } }
  const devtmpfs = DevTmpFS.prototype as unknown as {
    delete_node(this: DevTmpFS, device: Node): void
    create_node(this: DevTmpFS, device: Node): void
    _device(this: DevTmpFS, path: string, inode?: unknown): unknown
    statSync(this: DevTmpFS, path: string): unknown
  }
  const { delete_node, create_node, _device } = devtmpfs
  devtmpfs.delete_node = function (device) {
    const path = '/' + device.dev_node().name
    let inode: unknown
    try { inode = devtmpfs.statSync.call(this, path) } catch { /* not there */ }
    delete_node.call(this, device)
    if (inode !== undefined && [...held.values()].some(open => open.path === path)) unlinked.set(path, inode)
  }
  devtmpfs.create_node = function (device) {
    unlinked.delete('/' + device.dev_node().name)
    create_node.call(this, device)
  }
  devtmpfs._device = function (path, inode) {
    const kept = inode === undefined ? unlinked.get(path) : undefined
    if (kept === undefined) return _device.call(this, path, inode)
    try { return _device.call(this, path) } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      return _device.call(this, path, kept)
    }
  }

  const exit = Process.prototype.exit
  Process.prototype.exit = function (this: Process, ...args: Parameters<typeof exit>) {
    try { return exit.apply(this, args) } finally { sweepDevices() }
  }
}
