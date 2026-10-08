import { describe, expect, it } from 'vitest'

import { isolationProblem } from '#lib/isolation.ts'

describe('the isolation check', () => {
  it('passes where the platform has no isolation concept (Node, a test DOM)', () => {
    expect(isolationProblem({})).toBeUndefined()
  })

  it('passes on an isolated page', () => {
    expect(isolationProblem({ crossOriginIsolated: true, isSecureContext: true })).toBeUndefined()
  })

  it('names the two headers when the page is not isolated', () => {
    const problem = isolationProblem({ crossOriginIsolated: false, isSecureContext: true })!
    expect(problem).toContain('Cross-Origin-Opener-Policy: same-origin')
    expect(problem).toContain('Cross-Origin-Embedder-Policy: require-corp')
    expect(problem).not.toContain('secure context')
  })

  it('also says so when the page is not a secure context', () => {
    expect(isolationProblem({ crossOriginIsolated: false, isSecureContext: false })).toContain('secure context')
  })
})
