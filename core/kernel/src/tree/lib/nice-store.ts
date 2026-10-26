/**
 * The niceness of each process, what `nice` and `renice` set and `/proc/<pid>/stat` shows. There is no scheduler to give it
 * meaning: every process is a worker, and the browser decides when each runs. So the number is kept and inherited as Linux
 * does, and it changes nothing about how fast a program runs; the manual pages for `nice` and `renice` say so.
 */
import type { Process } from '@zenfs/linux'

export const NICE_MIN = -20
export const NICE_MAX = 19

const values = new WeakMap<Process, number>()

export const clampNice = (value: number): number => Math.min(NICE_MAX, Math.max(NICE_MIN, Math.trunc(value)))

export const niceOf = (process: Process): number => values.get(process) ?? 0

export function setNice(process: Process, value: number): number {
  const nice = clampNice(value)
  values.set(process, nice)
  return nice
}

/** A new process starts with its parent's niceness */
export function inheritNice(parent: Process, child: Process): void {
  values.set(child, niceOf(parent))
}
