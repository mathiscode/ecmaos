import { describe, it, expect } from 'vitest'
import binNodeSource from 'virtual:bin-node'

describe('virtual:bin-node', () => {
  it('bundles the interpreter into a single self-contained module with no import statements', () => {
    expect(typeof binNodeSource).toBe('string')
    expect(binNodeSource.length).toBeGreaterThan(0)
    expect(binNodeSource).not.toMatch(/^import /m)
  })
})
