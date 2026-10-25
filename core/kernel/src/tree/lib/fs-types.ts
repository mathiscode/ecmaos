/**
 * The filesystem types `mount -t` knows. The built-in ones (memory, zip, indexeddb, ...) and the ones a module adds with
 * `ctx.filesystem` are registered the same way, and `/proc/filesystems` lists them. A type that a module owns is busy while
 * anything of it is mounted, so `rmmod` refuses with `EBUSY` and a mounted filesystem is never left without its code.
 */

import type { Kernel } from '#kernel.ts'
import type { Shell } from '@ecmaos/types'

/** What a type's `mount` is given. `mount(config)` resolves a ZenFS mount config and mounts it at `target`. */
export interface FsMountRequest {
  type: string
  source: string
  /** Absolute */
  target: string
  cwd: string
  options: Record<string, string>
  /** False for `/etc/fstab` processing: types that need a person (a picker, an OAuth window) are skipped */
  interactive: boolean
  kernel: Kernel
  shell: Shell
  mount(config: unknown): Promise<void>
  /** Prints a line on stdout */
  out(text: string): void
  /** Ends the mount with `mount: MESSAGE`; a message of several lines prints the rest as they are */
  fail(message: string): never
  /** The bytes of a file or an `http(s):` URL (a relative path is taken from `cwd`) */
  read(source: string): Promise<Uint8Array>
}

export interface FsType {
  name: string
  /** `none`: `mount -t NAME TARGET`; `required`: `mount -t NAME SOURCE TARGET`; `optional` takes either */
  source: 'none' | 'optional' | 'required'
  /** Said when `/etc/fstab` would mount it, if it needs a person: the type is skipped */
  needsPerson?: string
  /** The module that added the type, shown by `lsmod`'s holders and refused to unload while mounted */
  owner?: string
  /** Mounts it. Resolves to `true` when it has already said what it did. */
  mount(request: FsMountRequest): Promise<boolean | void>
}

export class FsTypes {
  readonly #types = new Map<string, FsType>()
  /** The filesystems mounted from a type, so that `inUse` can tell whether any of them is still in the mount table */
  readonly #made = new Map<string, Set<unknown>>()

  /** `live` yields the filesystems in the mount table now */
  constructor(private readonly live: () => Iterable<unknown>) {}

  /** Adds a type and returns the function that takes it away. Throws if the name is taken. */
  register(type: FsType): () => void {
    const name = type.name.toLowerCase()
    if (this.#types.has(name)) throw Object.assign(new Error(`filesystem type ${name} is already registered`), { code: 'EEXIST' })
    this.#types.set(name, type)
    return () => {
      if (this.#types.get(name) === type) this.#types.delete(name)
      this.#made.delete(name)
    }
  }

  get(name: string): FsType | undefined {
    return this.#types.get(name.toLowerCase())
  }

  names(): string[] {
    return [...this.#types.keys()].sort()
  }

  /** Records that `fs` was made for the type, once it is mounted */
  track(name: string, fs: unknown): void {
    const key = name.toLowerCase()
    if (!this.#made.has(key)) this.#made.set(key, new Set())
    this.#made.get(key)!.add(fs)
  }

  /** How many filesystems of the type are mounted now */
  inUse(name: string): number {
    const made = this.#made.get(name.toLowerCase())
    if (!made?.size) return 0
    const live = new Set(this.live())
    for (const fs of [...made]) if (!live.has(fs)) made.delete(fs)
    return made.size
  }
}
