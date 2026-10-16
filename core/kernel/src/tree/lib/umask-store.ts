/**
 * The file mode creation mask of each process. The installed filesystem layer keeps none, so ecmaOS does: a process starts
 * with the mask of the shell that ran it (or of the process that spawned it), `umask` changes the calling process's own
 * mask, and the interpreter in each worker takes the mask off the mode of every file and directory the program creates
 * (`open` with `O_CREAT`, `mkdir`), which is where POSIX applies it.
 */
import type { Process } from '@zenfs/linux'

/** What a process starts with when nothing says otherwise, as a login on Linux does */
export const DEFAULT_UMASK = 0o022

const masks = new WeakMap<Process, number>()

export const umaskOf = (process: Process): number => masks.get(process) ?? DEFAULT_UMASK

export function setUmask(process: Process, mask: number): number {
  const old = umaskOf(process)
  masks.set(process, mask & 0o777)
  return old
}

/** A new process takes its parent's mask */
export function inheritUmask(parent: Process, child: Process): void {
  masks.set(child, umaskOf(parent))
}
