import { describe, expect, it } from 'vitest'

import { globPaths, globRegExp, hasGlobCharacters, type GlobFs } from '../../src/lib/glob.ts'

const matches = (pattern: string, text: string, options = {}) => globRegExp(pattern, options).test(text)

/** A directory tree as `{ path: children | null }`, `null` being a file. */
function treeFs(tree: Record<string, string[] | null>): GlobFs {
  const clean = (path: string) => path === '' ? '.' : path.replace(/\/$/, '') || '/'
  return {
    readdir: path => { const entry = tree[clean(path)]; if (!entry) throw new Error('ENOENT'); return [...entry] },
    isDirectory: path => Array.isArray(tree[clean(path)]),
    exists: path => clean(path) in tree,
  }
}

describe('patterns', () => {
  it('matches the basics', () => {
    expect(matches('a*c', 'abbc')).toBe(true)
    expect(matches('a?c', 'abc')).toBe(true)
    expect(matches('a?c', 'ac')).toBe(false)
    expect(matches('*', '')).toBe(true)
    expect(matches('a\\*c', 'a*c')).toBe(true)
    expect(matches('a\\*c', 'abc')).toBe(false)
  })

  it('reads bracket expressions: ranges, negation with ! or ^, a leading ], and POSIX classes', () => {
    expect(matches('g[1-3]', 'g2')).toBe(true)
    expect(matches('g[!1]', 'g1')).toBe(false)
    expect(matches('g[^1]', 'g2')).toBe(true)
    expect(matches('g[]x]', 'g]')).toBe(true)
    expect(matches('g[[:digit:]]', 'g7')).toBe(true)
    expect(matches('g[[:digit:]]', 'gx')).toBe(false)
    expect(matches('[[:alpha:][:digit:]]', '_')).toBe(false)
    expect(matches('[[:upper:]]*', 'Abc')).toBe(true)
    expect(matches('[[:space:]]', ' ')).toBe(true)
    expect(matches('a[', 'a[')).toBe(true)
  })

  it('is case-insensitive when asked', () => {
    expect(matches('ABC', 'abc')).toBe(false)
    expect(matches('ABC', 'abc', { nocase: true })).toBe(true)
    expect(matches('[a-c]x', 'BX', { nocase: true })).toBe(true)
  })

  it('knows extended patterns only with extglob', () => {
    expect(matches('@(a|b)', 'a')).toBe(false)
    const options = { extglob: true }
    expect(matches('@(a|b)', 'b', options)).toBe(true)
    expect(matches('@(a|b)', 'ab', options)).toBe(false)
    expect(matches('?(a|b)c', 'c', options)).toBe(true)
    expect(matches('?(a|b)c', 'ac', options)).toBe(true)
    expect(matches('*(a|b)c', 'ababc', options)).toBe(true)
    expect(matches('+(a|b)c', 'c', options)).toBe(false)
    expect(matches('+(a|b)c', 'abc', options)).toBe(true)
    expect(matches('!(a|b)', 'c', options)).toBe(true)
    expect(matches('!(a|b)', 'a', options)).toBe(false)
    expect(matches('!(a|b).txt', 'c.txt', options)).toBe(true)
    expect(matches('!(a|b).txt', 'a.txt', options)).toBe(false)
    expect(matches('x@(1|2@(3|4))y', 'x23y', options)).toBe(true)
  })

  it('says what counts as a wildcard', () => {
    expect(hasGlobCharacters('plain')).toBe(false)
    expect(hasGlobCharacters('a*')).toBe(true)
    expect(hasGlobCharacters('@(a)')).toBe(false)
    expect(hasGlobCharacters('@(a)', { extglob: true })).toBe(true)
  })
})

describe('pathname expansion', () => {
  const fs = treeFs({
    '.': ['a.txt', 'b.txt', 'c.md', '.hidden', 'dir'],
    'dir': ['x.txt', 'sub', '.dot'],
    'dir/sub': ['y.txt'],
    '/': ['etc'], '/etc': ['hosts', 'passwd'],
    'a.txt': null, 'b.txt': null, 'c.md': null, '.hidden': null, 'dir/x.txt': null, 'dir/.dot': null, 'dir/sub/y.txt': null,
    '/etc/hosts': null, '/etc/passwd': null,
  })

  it('matches names in the current directory, sorted, hiding dotfiles', async () => {
    expect(await globPaths('*.txt', fs)).toEqual(['a.txt', 'b.txt'])
    expect(await globPaths('*', fs)).toEqual(['a.txt', 'b.txt', 'c.md', 'dir'])
    expect(await globPaths('.*', fs)).toEqual(['.hidden'])
  })

  it('shows dotfiles with dotglob', async () => {
    expect(await globPaths('*', fs, { dotglob: true })).toEqual(['.hidden', 'a.txt', 'b.txt', 'c.md', 'dir'])
  })

  it('looks through directories segment by segment, absolute paths included', async () => {
    expect(await globPaths('*/*.txt', fs)).toEqual(['dir/x.txt'])
    expect(await globPaths('d*/s*/*.txt', fs)).toEqual(['dir/sub/y.txt'])
    expect(await globPaths('/e*/p*', fs)).toEqual(['/etc/passwd'])
  })

  it('keeps a trailing slash and then matches directories only', async () => {
    expect(await globPaths('*/', fs)).toEqual(['dir/'])
  })

  it('finds nothing for a pattern that matches nothing, or whose directory is missing', async () => {
    expect(await globPaths('*.zip', fs)).toEqual([])
    expect(await globPaths('nope/*', fs)).toEqual([])
  })

  it('uses ** for any depth only with globstar', async () => {
    expect(await globPaths('**/*.txt', fs)).toEqual(['dir/x.txt'])
    expect(await globPaths('**/*.txt', fs, { globstar: true })).toEqual(['a.txt', 'b.txt', 'dir/sub/y.txt', 'dir/x.txt'])
  })

  it('matches case-insensitively with nocase, and extended patterns with extglob', async () => {
    expect(await globPaths('A.*', fs, { nocase: true })).toEqual(['a.txt'])
    expect(await globPaths('@(a|b).txt', fs, { extglob: true })).toEqual(['a.txt', 'b.txt'])
    expect(await globPaths('!(a).txt', fs, { extglob: true })).toEqual(['b.txt'])
  })
})
