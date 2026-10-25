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
  /**
   * Adds a filesystem type to `mount -t` and `/proc/filesystems`. Fails with `EEXIST` if the name is taken. The module
   * cannot be unloaded while a filesystem of the type is mounted (`EBUSY`).
   */
  filesystem(spec: FilesystemSpec): void
  /**
   * Teaches `execve` a program format, as `binfmt_misc` does: a file `matches` recognizes is run as `interpreter FILE ARGS`.
   * It is tried after the formats for `#!` scripts and WebAssembly, which are exact, and before the one for JavaScript, which takes any text file.
   * Fails with `EEXIST` if the name is taken. Removed when the module unloads.
   */
  binfmt(spec: BinfmtSpec): void
  /**
   * Adds the syscall `name`, which a program makes with `ecmaosSyscalls.custom(name, ...args)`. `handler` returns a number
   * (a negative one is `-errno`), or nothing for 0. Fails with `EEXIST` if the name is taken; name it after the module.
   * Removed when the module unloads. A program restricted by a `.manifest.json` can make it only if it lists it.
   */
  syscall(name: string, handler: (call: SyscallCall, ...args: Array<string | number>) => number | void | Promise<number | void>): void
  /**
   * Adds a check to every syscall a process makes: when `policy` returns `false` the syscall fails with `EPERM`. It can only
   * deny, and a policy that throws is logged and ignored, so a broken one cannot lock the machine. Removed when the module unloads.
   */
  syscallPolicy(policy: (call: { syscall: string, pid: number, uid: number, exe?: string }) => boolean | void): void
}

/** Who made a syscall a module defined */
export interface SyscallCall {
  pid: number
  /** The effective user id */
  uid: number
  gid: number
  exe?: string
  /** Writes `text` to a file of the caller's (mode 600), for an answer too big to return; the caller reads it back */
  writeFile(path: string, text: string): Promise<void>
}

export interface BinfmtSpec {
  name: string
  /** `magic` is the first 256 bytes of the file */
  matches(program: { filename: string, magic: Uint8Array }): boolean
  /** The program that runs a file of this format, an absolute path (a command the module adds with `ctx.command`, say) */
  interpreter: string
}

export interface FilesystemSpec {
  /** What `mount -t NAME` says */
  name: string
  /** A ZenFS `Backend` (what `resolveMountConfig` takes as `backend`) */
  backend: object
  /** `none`: `mount -t NAME TARGET`; `required`: `mount -t NAME SOURCE TARGET`; `optional` takes either. @default 'none' */
  source?: 'none' | 'optional' | 'required'
  /** The options for the backend. Without this they are the `-o key=value` strings as given. */
  config?(request: FilesystemRequest): object | Promise<object>
  /** Said when `/etc/fstab` would mount it, if it needs a person (a picker, a sign-in window): the type is then skipped there */
  needsPerson?: string
}

export interface FilesystemRequest {
  source: string
  /** Absolute */
  target: string
  /** The `-o key=value` options of the mount */
  options: Record<string, string>
  /** The bytes of a file or of an `http(s):` URL; a relative path is taken from where `mount` was run */
  read(source: string): Promise<Uint8Array>
  /** Prints a line on stdout */
  out(text: string): void
  /** Ends the mount with `mount: MESSAGE`; the lines after the first are printed as they are */
  fail(message: string): never
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
