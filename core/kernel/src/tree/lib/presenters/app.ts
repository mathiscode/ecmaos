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
  const entryParams = {
    args,
    command,
    cwd: owner.cwd,
    uid: owner.credentials.uid,
    gid: owner.credentials.gid,
    pid: proc.pid,
    kernel,
    shell: owner,
    terminal: kernel.terminal,
    stdin: kernel.terminal.stdin,
    stdout: kernel.terminal.stdout,
    stderr: kernel.terminal.stderr
  } as unknown as ProcessEntryParams

  return { closed: Promise.resolve(main(entryParams)).then(code => typeof code === 'number' ? code : 0) }
}
