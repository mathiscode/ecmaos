/** Loaded modules by name; the same map `@zenfs/linux` keeps for `/proc/modules` */
export type KernelModules = ReadonlyMap<string, import('@zenfs/linux').Module>

/** What a module file says about itself before it is run: the `key=value` lines of its leading comment block */
export interface ModuleInfo {
  name: string
  version?: string
  description?: string
  author?: string[]
  license?: string
  /** A semver range of the module API the module was written for */
  kernelApi?: string
  /** Names of modules that must be loaded first */
  depends: string[]
  alias: string[]
  /** `name:type:description` for each parameter the module takes */
  parm: Array<{ name: string, type: 'string' | 'number' | 'boolean', description: string }>
  /** Every line, for `modinfo` to print as written */
  fields: Array<[string, string]>
}

/** Everything a module may use of the kernel; the `Kernel` object itself is never handed over */
export interface ModuleContext {
  /** The module's name */
  readonly name: string
  /** Parameter values: what `insmod` was given, else the default */
  param<T extends string | number | boolean>(name: string): T | undefined
  /** Writes a line to the kernel log (dmesg) as this module */
  log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  /** Makes `value` importable by other modules under `symbol`; undone when this module unloads */
  export(symbol: string, value: unknown): void
  /** The value another module exported; holds a reference on that module until this one unloads */
  import<T = unknown>(symbol: string): T
  /** Runs `undo` when the module unloads, last in first out */
  onExit(undo: () => void | Promise<void>): void
  /**
   * Adds `/proc/PATH` (directories on the way are made as needed). Fails with `EEXIST` if the name is taken. Removed when
   * the module unloads, along with any directory it made that is then empty.
   */
  proc(path: string, file: ProcFileSpec): void
  /**
   * Adds a directory of attributes at `/sys/kernel/PATH`. Fails with `EEXIST` if the directory is there already. Removed
   * when the module unloads.
   */
  sys(path: string, attributes: Record<string, AttributeSpec>): void
  /** Files in `/sys/kernel/debug/NAME/`, a directory of the module's own that exists while it is loaded (root only, mode 700) */
  debugfs: {
    /** A file that runs `read` and `write` when it is read or written */
    file(path: string, ops: DebugFileSpec): void
    /** A file for one value: the number, boolean or string `ref.value` holds, read and written through it */
    value(path: string, type: DebugValueType, ref: { value: number | bigint | boolean | string }, mode?: number): void
  }
  /** `/sys/kernel/config/NAME`, where `mkdir` makes an item from `make` and `rmdir` drops it */
  configfs: {
    subsystem(spec: ConfigSubsystemSpec): void
  }
  /**
   * Adds the program `/usr/bin/NAME`, an ES module run as an isolated process with `globalThis.ecmaosSyscalls`, like the
   * commands in `/bin`. Fails with `EEXIST` if there is already a file of that name. Removed when the module unloads.
   */
  command(name: string, source: string): Promise<void>
}

/** A file in `/proc`. A `store` that throws is logged and the write still succeeds: procfs fails every later close of a file whose write threw */
export interface ProcFileSpec {
  /** @default 0o444, or 0o644 with a `store` */
  mode?: number
  show(): string
  store?(value: string): void
}

/** A file in a `/sys` or configfs directory */
export interface AttributeSpec {
  /** @default 0o444, 0o644 with both, 0o200 with only a `store` */
  mode?: number
  show?(): string
  store?(value: string): void
}

export interface DebugFileSpec {
  /** @default 0o444, 0o644 with both, 0o200 with only a `write` */
  mode?: number
  read?(): string | Uint8Array
  write?(value: string): void
}

/** The sizes of `debugfs_create_*`: `x` shows hex; `u64` and `x64` hold a `bigint` */
export type DebugValueType = 'u8' | 'u16' | 'u32' | 'u64' | 'x8' | 'x16' | 'x32' | 'x64' | 'bool' | 'str'

export interface ConfigItemSpec {
  attributes?: Record<string, AttributeSpec>
  /** Runs when the item is removed (`rmdir`, or the module unloads) */
  release?(): void
}

export interface ConfigSubsystemSpec {
  /** The directory's name in `/sys/kernel/config` */
  name: string
  /** The attributes of the subsystem directory itself */
  attributes?: Record<string, AttributeSpec>
  /** Runs for `mkdir NAME`; throw to refuse */
  make(name: string): ConfigItemSpec
}

/** What a `.ko.mjs` file exports (as default, or as named `init` and `exit`) */
export interface KernelModule {
  init(context: ModuleContext): void | Promise<void>
  exit?(): void | Promise<void>
}
