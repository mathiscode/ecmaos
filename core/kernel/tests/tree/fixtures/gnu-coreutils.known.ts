/**
 * Where an ecmaOS coreutil still differs from GNU for a command in gnu-coreutils.corpus.mjs. Each entry pins what ecmaOS
 * prints today and why it is accepted, so the list can only shrink: a command that starts matching GNU, or changes what it
 * prints, fails the test until its entry is removed or updated.
 */
export interface KnownDifference {
  out: string
  code: number
  reason: string
}

export const known: Record<string, KnownDifference> = {}
