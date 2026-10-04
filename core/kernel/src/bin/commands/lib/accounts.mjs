/** What the account commands (`useradd`, `groupmod`, ...) share: one call into the kernel's root-only `users_manage`, and a standard way to report. */

import { readBackAndDelete, scratchPath } from './scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { exit, write, custom } = syscalls

const encoder = new TextEncoder()

/** Runs an account action as the kernel's `users_manage` and returns its answer (`{ error }` when it refused). */
export async function manage(action, args) {
  const path = scratchPath(`accounts-${action}`)
  await custom('users_manage', action, JSON.stringify(args), path)
  return JSON.parse(await readBackAndDelete(syscalls, path))
}

/** The usual way to end an account command: print what went wrong, or exit quietly as the Linux ones do on success. */
export function finish(name, result) {
  if (result.error) { write(2, encoder.encode(`${name}: ${result.error}\n`)); return 1 }
  if (result.warning) write(2, encoder.encode(`${name}: ${result.warning}\n`))
  return 0
}

export const say = (fd, text) => write(fd, encoder.encode(text))

/** Runs `main` and exits with its status, turning an exception into a message. */
export async function start(name, main) {
  try { exit(await main()) } catch (error) {
    say(2, `${name}: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  }
}
