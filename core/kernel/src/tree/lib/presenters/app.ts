import path from 'path'

import type { Process } from '@zenfs/linux'

import type { ProcessEntryParams, Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Presented } from './index.ts'

/**
 * The main-thread half of a DOM app (`#!ecmaos:bin:app:<name>`: webamp, the Monaco `code` editor, and
 * anything else that builds real DOM). The real process is `/bin/app`, a worker with a pid, signals and an
 * exit code; the app's own `main(params)` still needs `document`, so it runs here, on the main thread,
 * with the live `kernel`/`shell`/`terminal` it was written against -- the ABI DOM apps already have.
 *
 * The process lives as long as `main` does and exits with its number, as the old `executeApp` did. A
 * main-thread `main` cannot be interrupted from outside, so `^C` ends the process but the app's own
 * windows stay until it (or the user) closes them.
 */
export async function presentApp(kernel: Kernel, proc: Process, params: Record<string, unknown>, shell?: Shell): Promise<Presented> {
  const file = String(params['file'])
  const args = (params['args'] ?? []) as string[]
  const command = String(params['command'] ?? path.basename(file))

  const contents = await kernel.filesystem.fs.readFile(file, 'utf-8')
  // Installed apps are symlinks into their package (imports resolve relative to it); a plain file is its own base
  const binLink = await kernel.filesystem.fs.readlink(file).catch(() => file)
  const source = await kernel.replaceImports(contents, path.dirname(binLink))

  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  let main: (params: ProcessEntryParams) => unknown
  try {
    const module = await import(/* @vite-ignore */ url)
    main = module?.main || module?.default
    if (typeof main !== 'function') throw new Error('No main function found in module')
  } finally {
    URL.revokeObjectURL(url)
  }

  const owner = shell ?? kernel.shell

  // Apps written against the old `executeApp`-era ABI (e.g. `apps/code/src/main.ts`) destructure
  // `instance` and call `instance.open/exit/keepAlive` directly. `open` used to be the legacy
  // `Process`'s own file-open helper (deleted in 046a5609); `exit`/`keepAlive` decided whether the
  // process ended when `main` returned (a fire-and-forget window) or stayed alive until the app
  // called `exit` itself (e.g. a Monaco editor window that outlives `main` returning once its UI
  // is set up). This shim reproduces both against the current API, tying `keepAlive`/`exit` into
  // the `closed` promise `window_present` actually awaits.
  let resolveClosed!: (code: number) => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<number>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  let keptAlive = false
  let onDispose: (() => void) | undefined
  const instance = {
    open: (path: string, flags: string = 'r') => kernel.filesystem.fs.open(path, flags),
    exit: (code: number = 0) => resolveClosed(code),
    keepAlive: () => { keptAlive = true },
    onDispose: (callback: () => void) => { onDispose = callback }
  }

  const entryParams = {
    args,
    command,
    cwd: owner.cwd,
    uid: owner.credentials.uid,
    gid: owner.credentials.gid,
    pid: proc.pid,
    instance,
    kernel,
    shell: owner,
    terminal: kernel.terminal,
    stdin: kernel.terminal.stdin,
    stdout: kernel.terminal.stdout,
    stderr: kernel.terminal.stderr
  } as unknown as ProcessEntryParams

  Promise.resolve(main(entryParams))
    .then(code => { if (!keptAlive) resolveClosed(typeof code === 'number' ? code : 0) })
    .catch(rejectClosed)

  return { closed, dispose: () => onDispose?.() }
}
