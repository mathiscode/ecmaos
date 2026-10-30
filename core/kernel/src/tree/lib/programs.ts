import type { promises } from '@zenfs/core'

type Fs = Pick<typeof promises, 'stat' | 'lstat' | 'writeFile' | 'unlink'>

/**
 * Prebuilt WebAssembly programs (`vim`, `jq`, `make`, ...), published by `@ecmaos/coreutils` and `@ecmaos/coreutils-
 * copyleft` and served as a catalog at `/programs/index.json`. Boot writes `/bin/<name>` for any program whose
 * installed copy differs from the catalog.
 */
export interface ProgramEntry {
  file: string
  size: number
  sha256: string
  version: string
  license: string
  description: string
  /** The smallest profile that has the program (`minimal`, `standard`, `developer`, `everything`); without it, every profile does */
  profile?: string
  /**
   * Files the program needs beside it (`vim`'s runtime): a tarball rooted at `/`, in the same directory as the
   * program
   */
  runtime?: { file: string, size: number, sha256: string }
}

export interface ProgramPackage {
  name: string
  path: string
  programs: Record<string, ProgramEntry>
  /** Programs that left the catalog for npm, by the package that carries each (`jq: '@ecmaos-apps/jq'`) */
  moved?: Record<string, string>
}

export interface ProgramCatalog {
  packages: ProgramPackage[]
}

export interface InstallProgramsOptions {
  /** Where the catalog is; the programs are fetched relative to it (`<path>/<file>`). */
  catalogUrl: string
  /** Programs not to install (the kernel's command blacklist). */
  skip?: (name: string) => boolean
  /** Whether a program is wanted on this machine (its profile); one that is not is neither fetched nor given a placeholder, and one already here is left alone */
  include?: (name: string, entry: ProgramEntry) => boolean
  /**
   * The hash each installed program had when it was written, so a boot compares sizes instead of reading every
   * binary.
   */
  stamps: { read(): Record<string, string>, write(stamps: Record<string, string>): void }
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  /** Unpacks a runtime tarball into the filesystem; without it, runtimes are not installed */
  extract?: (tarball: Uint8Array) => Promise<void>
}

export interface InstallProgramsResult {
  installed: string[]
  current: string[]
  failed: Record<string, string>
  /** Programs this machine had from the catalog that are npm packages now: the copy here keeps working and is no longer updated; `install` brings the package */
  moved: Record<string, string>
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')

/** How many programs are fetched and written at once */
const CONCURRENCY = 6

/** The program a placeholder names as its interpreter: it waits for the real program, then runs it */
export const PROGRAM_WAITER = '/usr/libexec/ecmaos/wait-for-program'

/**
 * What `/bin/<name>` holds while the program downloads. It is on `PATH` like the program, so a shell, `which` and
 * `execve` all find it. It is a `#!` script, not JS of its own: a JS file is read twice when it is run (once to see what
 * it is, then by the worker), and the program could land between the two.
 */
export const PLACEHOLDER = `#!${PROGRAM_WAITER}\n# ecmaOS: this program is still being installed\n`

/**
 * {@link PROGRAM_WAITER}: waits for the file it is given to stop being the placeholder, then runs it with the same
 * arguments and ends with its status. If the install fails the placeholder is removed, and a waiting run says so.
 */
export const programWaiterSource = `// ecmaOS: runs a program that is still being installed once it is (see PLACEHOLDER in the kernel's lib/programs.ts)
const { argv, env, exit, writeAll, open, read, close, spawn, waitpid, getcwd, onSignal, O_RDONLY } = globalThis.ecmaosSyscalls
const path = argv[1]
const name = path.split('/').pop()
const mark = new TextEncoder().encode(${JSON.stringify(PLACEHOLDER)})
const say = text => writeAll(2, new TextEncoder().encode(name + ': ' + text + '\\n'))
// 'gone' when the file was removed (the install failed), 'waiting' while it is the placeholder, 'ready' after
const state = () => {
  let fd
  try { fd = open(path, O_RDONLY) } catch { return 'gone' }
  try {
    const head = new Uint8Array(mark.length)
    const n = read(fd, head, -1)
    // empty while the program is being written over it
    if (n <= 0) return 'waiting'
    return n === mark.length && head.every((byte, i) => byte === mark[i]) ? 'waiting' : 'ready'
  } finally { close(fd) }
}
const started = Date.now()
let told = false
for (;;) {
  const now = state()
  if (now === 'ready') break
  if (now === 'gone') { say('could not be installed'); exit(127) }
  if (Date.now() - started > 300000) { say('is still being installed; try again shortly'); exit(126) }
  if (!told && Date.now() - started > 1000) { say('still being installed; it starts when it is ready'); told = true }
  await new Promise(resolve => setTimeout(resolve, 100))
}
// as a shell waits for a foreground job: ^C and ^\\ are for the program, which may take them and go on (the handlers
// are not inherited; the program starts with the default actions)
for (const signal of [2, 3]) onSignal(signal, () => {})
const pid = await spawn(path, [path, ...argv.slice(2)], { cwd: getcwd(), env })
for (;;) {
  try {
    const done = await waitpid(pid, false)
    exit(done.signal ? 128 + done.signal : done.code)
  } catch (error) {
    if (!String(error?.code ?? error?.message ?? error).includes('EINTR')) throw error
  }
}
`

export interface StagedPrograms {
  /** Programs that got a placeholder because nothing was installed under their name */
  placeholders: string[]
  /** Starts the downloads (once) and settles when every program is installed or has failed; it never rejects */
  start(): Promise<InstallProgramsResult>
}

/**
 * Fetches the catalog and, with `placeholders`, writes one for each program not installed yet ({@link PLACEHOLDER};
 * the caller installs {@link PROGRAM_WAITER}). `start` installs the
 * programs: several at a time, each one's stamp saved as it lands. Boot waits for the first part only.
 */
export async function stagePrograms(fs: Fs, options: InstallProgramsOptions & { placeholders?: boolean }): Promise<StagedPrograms> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init))
  const result: InstallProgramsResult = { installed: [], current: [], failed: {}, moved: {} }

  let catalog: ProgramCatalog
  try {
    const response = await fetcher(options.catalogUrl, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    catalog = await response.json() as ProgramCatalog
  } catch (error) {
    result.failed['(catalog)'] = `${options.catalogUrl}: ${(error as Error).message}`
    return { placeholders: [], start: () => Promise.resolve(result) }
  }

  const stamps = options.stamps.read()
  const sha = async (bytes: Uint8Array) => globalThis.crypto?.subtle ? hex(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)) : undefined
  const fetchFile = async (pkg: ProgramPackage, entry: { file: string, size: number, sha256: string }) => {
    const url = new URL(`${pkg.path}/${entry.file}`, new URL(options.catalogUrl, globalThis.location?.href ?? 'http://localhost/'))
    url.searchParams.set('v', entry.sha256.slice(0, 16)) // a changed file is a new URL, so no cache serves the old one
    const response = await fetcher(url.href)
    if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== entry.size) throw new Error(`${entry.file} is ${bytes.length} bytes, the catalog says ${entry.size}`)
    // `crypto.subtle` exists only in a secure context; where it does not, the size check above is all there is.
    const actual = await sha(bytes)
    if (actual !== undefined && actual !== entry.sha256) throw new Error(`${entry.file} does not match the catalog's sha256`)
    return bytes
  }

  // A program that moved to npm keeps the copy an earlier boot wrote: it works, but is no longer updated. The package
  // replaces the file when it is installed. One this machine never had from the catalog (no stamp) is not mentioned.
  for (const [name, npmPackage] of catalog.packages.flatMap(pkg => Object.entries(pkg.moved ?? {}))) {
    if (name in stamps) result.moved[name] = npmPackage
  }

  const programs = catalog.packages.flatMap(pkg => Object.entries(pkg.programs).map(([name, entry]) => ({ pkg, name, entry })))
    .filter(({ name, entry }) => !options.skip?.(name) && (options.include?.(name, entry) ?? true))

  const placeholders: string[] = []
  if (options.placeholders) {
    for (const { name } of programs) {
      const target = `/bin/${name}`
      if (await fs.lstat(target).catch(() => undefined)) continue
      try {
        await fs.writeFile(target, PLACEHOLDER, { mode: 0o755 })
        placeholders.push(name)
      } catch { /* the program is installed without one */ }
    }
  }

  const install = async ({ pkg, name, entry }: typeof programs[number]) => {
    if (entry.runtime && options.extract && stamps[`${name}:runtime`] !== entry.runtime.sha256) {
      try {
        await options.extract(await fetchFile(pkg, entry.runtime))
        stamps[`${name}:runtime`] = entry.runtime.sha256
        options.stamps.write(stamps)
      } catch (error) {
        result.failed[`${name} (runtime)`] = (error as Error).message
      }
    }
    const target = `/bin/${name}`
    try {
      // An earlier build linked `vim` to `vi`; writing through that link would replace the other program.
      if ((await fs.lstat(target).catch(() => undefined))?.isSymbolicLink()) await fs.unlink(target)
      const installed = await fs.stat(target).catch(() => undefined)
      if (installed?.isFile() && installed.size === entry.size && stamps[name] === entry.sha256) { result.current.push(name); return }

      const bytes = await fetchFile(pkg, entry)
      await fs.writeFile(target, bytes, { mode: 0o755 })
      stamps[name] = entry.sha256
      options.stamps.write(stamps)
      result.installed.push(name)
    } catch (error) {
      result.failed[name] = (error as Error).message
      // a placeholder left behind would wait for a program that is not coming
      if (placeholders.includes(name)) await fs.unlink(target).catch(() => {})
    }
  }

  let finished: Promise<InstallProgramsResult> | undefined
  const run = async () => {
    const queue = [...programs]
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await install(next)
    }))
    // in catalog order, however the downloads finished
    const order = programs.map(({ name }) => name)
    for (const list of [result.installed, result.current]) list.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    return result
  }
  return { placeholders, start: () => (finished ??= run()) }
}

/**
 * Writes `/bin/<name>` for each catalog program that is missing or differs, and resolves when all are done. An
 * unreachable catalog is not an error; a program that fails (missing file, hash mismatch) is reported and the rest
 * still install.
 */
export async function installPrograms(fs: Fs, options: InstallProgramsOptions): Promise<InstallProgramsResult> {
  return await (await stagePrograms(fs, options)).start()
}
