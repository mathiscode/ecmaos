/**
 * The hooks of a module that add files: `/proc` and `/sys` entries, debugfs, configfs and commands. Each one registers its own
 * undo step, so unloading a module leaves nothing of it behind. A module reaches these only through its `ModuleContext`.
 */

import { ConfigGroup, ConfigItem } from '@zenfs/linux/fs/configfs'
import {
  DebugDir, DebugFile,
  debugfs_create_bool, debugfs_create_str,
  debugfs_create_u8, debugfs_create_u16, debugfs_create_u32, debugfs_create_u64,
  debugfs_create_x8, debugfs_create_x16, debugfs_create_x32, debugfs_create_x64
} from '@zenfs/linux/fs/debugfs'
import { ProcDir, proc_root, type ProcEntry } from '@zenfs/linux/fs/procfs'
import { KObject, kernel_kobj } from '@zenfs/linux/kobject'
import type { AttributeSpec, ConfigItemSpec, ConfigSubsystemSpec, DebugFileSpec, DebugValueType, ModuleContext, ProcFileSpec } from '@ecmaos/types'

type Hooks = Pick<ModuleContext, 'proc' | 'sys' | 'debugfs' | 'configfs' | 'command'>

export interface HookHost {
  log: { warn(message: string): void }
  /** Writes `/usr/bin/NAME` (see `ModuleContext.command`) and throws a `ModuleError` if the name is taken */
  commands?: { install(name: string, source: string): Promise<void>, remove(name: string): Promise<void> }
}

export interface HookOptions {
  module: string
  host: HookHost
  /** The module's undo list, run last in first out when it unloads */
  undo: Array<() => void | Promise<void>>
  fail(code: string, message: string): Error
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
/** `/sys/kernel/debug` and `/sys/kernel/config` are other filesystems mounted over these two */
const MOUNTED = new Set(['debug', 'config'])

const DEBUG_VALUES = {
  u8: debugfs_create_u8, u16: debugfs_create_u16, u32: debugfs_create_u32, u64: debugfs_create_u64,
  x8: debugfs_create_x8, x16: debugfs_create_x16, x32: debugfs_create_x32, x64: debugfs_create_x64,
  bool: debugfs_create_bool, str: debugfs_create_str
} as const

export function createHooks({ module, host, undo, fail }: HookOptions): Hooks {
  const segments = (path: string, what: string): string[] => {
    const parts = path.split('/').filter(Boolean)
    if (!parts.length || !parts.every(part => NAME.test(part))) throw fail('EINVAL', `${module}: bad ${what} path '${path}'`)
    return parts
  }

  /** Procfs, sysfs and debugfs keep a file whose write threw dirty, and every later close of it fails with EIO; a refused write is logged instead */
  const guarded = <T extends unknown[]>(what: string, run: ((...args: T) => void) | undefined) => run && ((...args: T) => {
    try {
      run(...args)
    } catch (error) {
      host.log.warn(`${module}: write to ${what} refused: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const attributes = <Self>(target: { create_attribute(name: string, show?: ((self: Self) => string) | null, store?: ((self: Self, value: string) => void) | null, mode?: number): unknown }, where: string, specs: Record<string, AttributeSpec>) => {
    for (const [name, spec] of Object.entries(specs)) {
      if (!NAME.test(name)) throw fail('EINVAL', `${module}: bad attribute name '${name}'`)
      const store = guarded(`${where}/${name}`, spec.store)
      target.create_attribute(name, spec.show ? () => spec.show!() : null, store ? (_self, value) => store(value) : null, spec.mode)
    }
  }

  let debugRoot: DebugDir | undefined
  const debugDir = (): DebugDir => {
    if (!debugRoot) {
      debugRoot = new DebugDir(module)
      undo.push(() => { debugRoot?.dispose(); debugRoot = undefined })
    }
    return debugRoot
  }
  /** The directory for a debugfs path's parents, made as needed inside the module's own */
  const debugParent = (parts: string[]): DebugDir => {
    let dir = debugDir()
    for (const part of parts.slice(0, -1)) {
      const next = dir.children.get(part)
      if (next && !(next instanceof DebugDir)) throw fail('ENOTDIR', `${module}: debugfs ${part} is not a directory`)
      dir = (next as DebugDir | undefined) ?? new DebugDir(part, dir)
    }
    return dir
  }
  const debugMode = (mode: number | undefined, has: { read: boolean, write: boolean }) => mode ?? (has.write ? (has.read ? 0o644 : 0o200) : 0o444)

  return {
    proc(path: string, spec: ProcFileSpec) {
      const parts = segments(path, 'proc')
      const leaf = parts.pop()!
      const made: Array<[ProcDir, string]> = []
      let dir: ProcDir = proc_root
      for (const part of parts) {
        let next: ProcEntry | undefined = dir.lookup(part)
        if (!next) {
          next = new ProcDir()
          dir.children.set(part, next)
          made.push([dir, part])
        } else if (!(next instanceof ProcDir)) throw fail('ENOTDIR', `${module}: /proc/${part} is not a directory`)
        dir = next
      }
      const forget = () => {
        for (const [parent, name] of made.reverse()) {
          const child = parent.children.get(name)
          if (child instanceof ProcDir && !child.children.size) parent.children.delete(name)
        }
      }
      if (dir.lookup(leaf)) {
        forget()
        throw fail('EEXIST', `${module}: /proc/${[...parts, leaf].join('/')} exists`)
      }
      const parent = dir
      const entry = { mode: spec.mode ?? (spec.store ? 0o644 : 0o444), show: () => spec.show(), store: guarded(`/proc/${[...parts, leaf].join('/')}`, spec.store) }
      parent.children.set(leaf, entry)
      undo.push(() => {
        if (parent.children.get(leaf) === entry) parent.children.delete(leaf)
        forget()
      })
    },

    sys(path: string, specs: Record<string, AttributeSpec>) {
      const parts = segments(path, 'sys')
      if (MOUNTED.has(parts[0]!)) throw fail('EINVAL', `${module}: /sys/kernel/${parts[0]} is a mount point`)
      let parent: KObject = kernel_kobj
      let top: KObject | undefined
      for (const [index, part] of parts.entries()) {
        const existing = parent.children.get(part)
        if (index === parts.length - 1 && (existing || parent.attributes.has(part))) throw fail('EEXIST', `${module}: /sys/kernel/${parts.join('/')} exists`)
        if (existing && !(existing instanceof KObject)) throw fail('ENOTDIR', `${module}: /sys/kernel/${part} is not a directory`)
        const next: KObject = (existing as KObject | undefined) ?? new KObject(part, parent)
        if (!existing) top ??= next
        parent = next
      }
      undo.push(() => top?.dispose())
      try {
        attributes(parent, `/sys/kernel/${parts.join('/')}`, specs)
      } catch (error) {
        top?.dispose()
        undo.pop()
        throw error
      }
    },

    debugfs: {
      file(path: string, ops: DebugFileSpec) {
        const parts = segments(path, 'debugfs')
        const dir = debugParent(parts)
        const name = parts.at(-1)!
        if (dir.children.has(name)) throw fail('EEXIST', `${module}: debugfs ${path} exists`)
        const file = new DebugFile(name, dir, debugMode(ops.mode, { read: !!ops.read, write: !!ops.write }), { read: ops.read && (() => ops.read!()), write: ops.write })
        file.store = guarded(`debugfs ${module}/${path}`, ops.write)
      },

      value(path: string, type: DebugValueType, ref: { value: number | bigint | boolean | string }, mode = 0o644) {
        const create = (DEBUG_VALUES as Record<string, unknown>)[type] as ((name: string, mode: number, parent: DebugDir, ref: unknown) => DebugFile) | undefined
        if (!create) throw fail('EINVAL', `${module}: bad debugfs value type '${type}'`)
        const parts = segments(path, 'debugfs')
        const dir = debugParent(parts)
        const name = parts.at(-1)!
        if (dir.children.has(name)) throw fail('EEXIST', `${module}: debugfs ${path} exists`)
        const file = create(name, mode, dir, ref)
        file.store = guarded(`debugfs ${module}/${path}`, file.store)
      }
    },

    configfs: {
      subsystem(spec: ConfigSubsystemSpec) {
        if (!NAME.test(spec.name)) throw fail('EINVAL', `${module}: bad configfs name '${spec.name}'`)
        const where = `/sys/kernel/config/${spec.name}`
        const build = (name: string, item: ConfigItemSpec): ConfigItem => {
          const made = new ConfigItem(name)
          attributes(made, `${where}/${name}`, item.attributes ?? {})
          made.release = () => {
            try {
              item.release?.()
            } catch (error) {
              host.log.warn(`${module}: releasing ${where}/${name} failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          return made
        }
        const group = new ConfigGroup(spec.name)
        group.make_item = name => build(name, spec.make(name))
        attributes(group, where, spec.attributes ?? {})
        try {
          group.registerSubsystem()
        } catch {
          throw fail('EEXIST', `${module}: ${where} exists`)
        }
        undo.push(() => {
          for (const child of [...group.children.values()]) if (child instanceof ConfigItem) child.detach()
          group.unregisterSubsystem()
        })
      }
    },

    async command(name: string, source: string) {
      if (!NAME.test(name)) throw fail('EINVAL', `${module}: bad command name '${name}'`)
      if (!host.commands) throw fail('ENOSYS', `${module}: this kernel cannot add commands`)
      await host.commands.install(name, source)
      undo.push(() => host.commands!.remove(name))
    }
  }
}
