/**
 * The program-side half of a presenter (`#lib/presenters/index.ts`): asks the kernel to put
 * something on screen and throws the presenter's own error message if it could not, and otherwise returns `{ result }`, whatever the presenter reported. Uses the
 * scratch-file result convention (`lib/scratch.mjs`) every kernel-native custom syscall shares.
 */
import { readBackAndDelete, scratchPath } from './scratch.mjs'

export async function present(syscalls, kind, params) {
  const path = scratchPath(`present-${kind}`)
  await syscalls.custom('window_present', kind, JSON.stringify(params), path)
  const result = JSON.parse(await readBackAndDelete(syscalls, path))
  if (result.error) throw new Error(result.error)
  return result
}
