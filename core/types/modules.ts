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
}

/** What a `.ko.mjs` file exports (as default, or as named `init` and `exit`) */
export interface KernelModule {
  init(context: ModuleContext): void | Promise<void>
  exit?(): void | Promise<void>
}
