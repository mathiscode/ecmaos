import { describe, expect, it } from 'vitest'

import { completionMatches, type CompletionProvider } from '../../src/lib/completion.ts'

/** A provider over a tiny fake tree, so completion runs with no terminal and no shell. */
const provider = (overrides: Partial<CompletionProvider> = {}): CompletionProvider => {
  const tree: Record<string, string[]> = {
    '/bin': ['cat', 'cal', 'echo', 'ls'],
    '/work': ['notes.txt', 'src', 'my file.txt', 'Readme'],
    '/work/src': ['main.ts', 'util.ts'],
    '/root': ['docs']
  }
  const dirs = new Set(['/work/src', '/root/docs'])
  return {
    listDir: async dir => { if (!tree[dir]) throw new Error('ENOENT'); return tree[dir]! },
    isDirectory: async target => dirs.has(target) || target === '/work/src',
    variable: name => ({ PATH: '/bin:/nowhere', HOME: '/root' })[name],
    cwd: '/work',
    expandTilde: text => text.replace(/^~/, '/root'),
    builtins: ['cd', 'export', 'type'],
    ...overrides
  }
}

describe('completionMatches', () => {
  it('completes a command from builtins and $PATH, skipping a $PATH entry that does not exist', async () => {
    expect(await completionMatches('ca', provider())).toEqual(expect.arrayContaining(['cat', 'cal']))
    expect(await completionMatches('e', provider())).toEqual(['export', 'echo'])
  })

  it('lists builtins, which have no file under $PATH', async () => {
    expect(await completionMatches('cd', provider())).toContain('cd')
  })

  it('completes a filename and returns the whole line', async () => {
    expect(await completionMatches('cat no', provider())).toEqual(['cat notes.txt'])
  })

  it('matches case-insensitively', async () => {
    expect(await completionMatches('cat read', provider())).toEqual(['cat Readme'])
  })

  it('appends a slash to a directory', async () => {
    expect(await completionMatches('cd sr', provider())).toEqual(['cd src/'])
  })

  it('escapes characters a word cannot contain', async () => {
    expect(await completionMatches('cat my', provider())).toEqual(['cat my\\ file.txt'])
  })

  it('completes inside a subdirectory', async () => {
    expect(await completionMatches('cat src/m', provider())).toEqual(['cat src/main.ts'])
  })

  it('lists every entry for a line ending in a slash, instead of running ls', async () => {
    expect(await completionMatches('cat ./src/', provider())).toEqual(['cat ./src/main.ts', 'cat ./src/util.ts'])
  })

  it('keeps a typed tilde', async () => {
    expect(await completionMatches('cd ~/do', provider())).toEqual(['cd ~/docs/'])
  })

  it('returns nothing for an unreadable directory or an empty last word', async () => {
    expect(await completionMatches('cat /missing/x', provider())).toEqual([])
    expect(await completionMatches('cat ', provider())).toEqual([])
  })
})
