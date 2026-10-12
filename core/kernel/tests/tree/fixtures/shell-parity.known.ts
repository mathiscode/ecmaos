/**
 * Where a shell differs from bash on a corpus case, with its actual output and a reason. The actual output is pinned,
 * so fixing a divergence fails the test until the entry is deleted.
 */
export interface KnownDivergence {
  stdout: string
  status: number
  why: string
}

export type KnownTable = Record<string, KnownDivergence>

export const knownKernel: KnownTable = {}

export const knownEcmash: KnownTable = {}
