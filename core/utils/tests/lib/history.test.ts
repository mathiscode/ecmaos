import { describe, expect, it } from 'vitest'

import { History, type HistoryHost } from '../../src/lib/history.ts'

/** An in-memory filesystem that counts reads, since not re-reading the file is half the point. */
const setup = (initial?: string, variables: Record<string, string> = {}) => {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set('/h', initial)
  const reads = { count: 0 }
  const errors: string[] = []
  const host: HistoryHost = {
    fs: () => ({
      exists: async p => files.has(p),
      readFile: async p => { reads.count++; return files.get(p) ?? '' },
      writeFile: async (p, data) => { files.set(p, data) },
    }),
    file: () => '/h',
    variable: name => variables[name],
    error: message => { errors.push(message) }
  }
  return { history: new History(host), files, reads, errors, variables }
}

describe('History', () => {
  it('loads once and serves everything from memory', async () => {
    const { history, reads } = setup('a\nb\nc\n')
    await history.load(0)
    await history.load(0)
    expect(history.entries(0)).toEqual(['a', 'b', 'c'])
    // The old code re-read the whole file on every ArrowUp that missed its 100-line cache.
    expect(reads.count).toBe(1)
  })

  it('appends without reading the file back', async () => {
    const { history, files, reads } = setup('a\n')
    await history.load(0)
    reads.count = 0
    await history.add(0, 'b')
    await history.add(0, 'c')
    expect(reads.count).toBe(0)
    expect(files.get('/h')).toBe('a\nb\nc\n')
  })

  it('appends correctly to a file an older terminal wrote, which has no final newline', async () => {
    const { history, files } = setup('a\nb')
    await history.load(0)
    await history.add(0, 'c')
    expect(files.get('/h')).toBe('a\nb\nc\n')
    expect(history.entries(0)).toEqual(['a', 'b', 'c'])
  })

  it('skips a line starting with a space and a repeat of the previous line by default', async () => {
    const { history } = setup('')
    expect(await history.add(0, 'ls')).toBe(true)
    expect(await history.add(0, 'ls')).toBe(false)
    expect(await history.add(0, ' secret')).toBe(false)
    expect(await history.add(0, '   ')).toBe(false)
    expect(history.entries(0)).toEqual(['ls'])
  })

  it('follows HISTCONTROL', async () => {
    const dups = setup('', { HISTCONTROL: 'ignoredups' })
    await dups.history.add(0, ' spaced')
    await dups.history.add(0, ' spaced')
    expect(dups.history.entries(0)).toEqual([' spaced'])

    const none = setup('', { HISTCONTROL: '' })
    await none.history.add(0, 'x')
    await none.history.add(0, 'x')
    expect(none.history.entries(0)).toEqual(['x', 'x'])
  })

  it('erasedups removes earlier copies, in memory and in the file', async () => {
    const { history, files } = setup('a\nb\na\n', { HISTCONTROL: 'erasedups' })
    await history.add(0, 'a')
    expect(history.entries(0)).toEqual(['b', 'a'])
    expect(files.get('/h')).toBe('b\na\n')
  })

  it('bounds memory with HISTSIZE', async () => {
    const { history } = setup('1\n2\n3\n4\n5\n', { HISTSIZE: '3' })
    await history.load(0)
    expect(history.entries(0)).toEqual(['3', '4', '5'])
    await history.add(0, '6')
    expect(history.entries(0)).toEqual(['4', '5', '6'])
  })

  it('trims the file to HISTFILESIZE on load', async () => {
    const { history, files } = setup('1\n2\n3\n4\n5\n', { HISTFILESIZE: '2' })
    await history.load(0)
    expect(files.get('/h')).toBe('4\n5\n')
  })

  it('stores a multi-line command as one line, joined with semicolons', async () => {
    const { history, files } = setup('')
    await history.add(0, 'for i in 1 2\ndo echo $i\ndone')
    expect(history.entries(0)).toEqual(['for i in 1 2; do echo $i; done'])
    expect(files.get('/h')).toBe('for i in 1 2; do echo $i; done\n')
  })

  it('joins after a block opener with a space, so the recalled line is valid shell', async () => {
    const { history } = setup('')
    await history.add(0, 'for i in 1 2; do\n  echo n$i\ndone')
    await history.add(0, 'if true; then\n  echo a\nelse\n  echo b\nfi')
    await history.add(0, 'a &&\nb\nc | \nd')
    expect(history.entries(0)).toEqual([
      'for i in 1 2; do echo n$i; done',
      'if true; then echo a; else echo b; fi',
      'a && b; c | d',
    ])
  })

  it('does not record a heredoc, which cannot be joined without breaking it', async () => {
    const { history } = setup('')
    expect(await history.add(0, 'cat <<EOF\nbody\nEOF')).toBe(false)
    expect(history.entries(0)).toEqual([])
  })

  it('keeps a position per user', async () => {
    const { history } = setup('a\nb\n')
    await history.load(0)
    history.setPosition(0, 1)
    expect(history.position(0)).toBe(1)
    expect(history.position(1000)).toBe(0)
  })

  it('returns to the end of the list after adding a command', async () => {
    const { history } = setup('a\nb\n')
    await history.load(0)
    history.setPosition(0, 0)
    await history.add(0, 'c')
    expect(history.position(0)).toBe(3)
  })

  it('clear empties memory and disk', async () => {
    const { history, files } = setup('a\nb\n')
    await history.load(0)
    await history.clear(0)
    expect(history.entries(0)).toEqual([])
    expect(files.get('/h')).toBe('')
  })

  it('does not throw or log when the filesystem is not ready yet', async () => {
    const errors: string[] = []
    const history = new History({ fs: () => undefined, file: () => '/h', variable: () => undefined, error: m => errors.push(m) })
    await history.load(0)
    expect(await history.add(0, 'x')).toBe(true)
    expect(errors).toEqual([])
  })
})
