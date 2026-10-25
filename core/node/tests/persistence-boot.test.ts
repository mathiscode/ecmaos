import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

// The first boot of a machine with nothing yet: the initfs and the programs are what it installs
describe.skipIf(!supported)('the first boot', () => {
  it('starts from its bundled initfs and programs, offline', async () => {
    const session = new Session(['--quiet'], { fresh: true })
    await session.ready()
    try {
      expect(await session.run('ls /usr/share/docs/@ecmaos/kernel | head -1')).not.toBe('')
      expect(await session.run('jq --version')).toMatch(/^jq-/)
    } finally { await session.stop() }
  })

  it('keeps Vim-licensed files out of its own initfs, and installs the runtime with vim', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { readFileSync } = await import('node:fs')
    const tar = gunzipSync(readFileSync(path.resolve(import.meta.dirname, '../dist/initfs.tar.gz'))).toString('latin1')
    // Entry names are the 100-byte first field of each 512-byte header (file contents may mention the path)
    const names: string[] = []
    for (let at = 0; at + 512 <= tar.length && tar[at] !== '\0'; at += 512 + Math.ceil(parseInt(tar.slice(at + 124, at + 135), 8) / 512) * 512) names.push(tar.slice(at, at + 100).replace(/\0.*$/, ''))
    expect(names.length).toBeGreaterThan(100)
    expect(names.filter(name => name.includes('share/vim'))).toEqual([])

    const session = new Session(['--quiet'], { fresh: true })
    await session.ready()
    try {
      // vim is in the copyleft package, installed beside this one in the workspace. Programs download after boot, each
      // runtime before its program, so running vim waits for both
      expect(await session.run('vim --version 2>/dev/null | head -1', 60_000)).toMatch(/^VIM /)
      expect(await session.run('ls /usr/share/vim/vim91 | head -3')).toContain('autoload')
      expect(await session.run('test -f /usr/share/vim/vim91/syntax/c.vim && echo yes')).toBe('yes')
    } finally { await session.stop() }
  })

  it('has no vim and no runtime without the copyleft package', async () => {
    const session = new Session(['--quiet'], { env: { ...process.env, ECMAOS_COPYLEFT: '0' }, fresh: true })
    await session.ready()
    try {
      expect(await session.run('test -e /bin/vim && echo yes || echo no')).toBe('no')
      expect(await session.run('test -e /usr/share/vim && echo yes || echo no')).toBe('no')
    } finally { await session.stop() }
  })
})
