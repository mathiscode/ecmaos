import { describe, expect, it } from 'vitest'

import { parseEnvironment, startupFiles } from '../../src/lib/shell-core/startup-files.ts'

/** A host over a set of file paths; a directory lists the names directly beneath it. */
const host = (files: string[]) => ({
  isFile: (path: string) => files.includes(path),
  list: (dir: string) => files.filter(file => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/')).map(file => file.slice(dir.length + 1))
})

describe('startupFiles', () => {
  it('reads the system profile, profile.d scripts in order, then only the first user profile', async () => {
    const files = ['/etc/profile', '/etc/profile.d/b.sh', '/etc/profile.d/a.sh', '/etc/profile.d/note.txt', '/home/u/.profile', '/home/u/.ecmash_profile', '/home/u/.bash_profile']
    expect(await startupFiles({ home: '/home/u', login: true, interactive: false }, host(files))).toEqual([
      '/etc/profile', '/etc/profile.d/a.sh', '/etc/profile.d/b.sh', '/home/u/.bash_profile'
    ])
  })

  it('falls through .bash_profile, .ecmash_profile, .profile', async () => {
    expect(await startupFiles({ home: '/h', login: true, interactive: false }, host(['/h/.profile', '/h/.ecmash_profile']))).toEqual(['/h/.ecmash_profile'])
    expect(await startupFiles({ home: '/h', login: true, interactive: false }, host(['/h/.profile']))).toEqual(['/h/.profile'])
  })

  it('reads every rc file for an interactive shell, system first', async () => {
    const files = ['/etc/ecmashrc', '/h/.bashrc', '/h/.ecmashrc', '/h/.profile']
    expect(await startupFiles({ home: '/h', login: false, interactive: true }, host(files))).toEqual(['/etc/ecmashrc', '/h/.bashrc', '/h/.ecmashrc'])
  })

  it('reads profile then rc files for a login interactive shell', async () => {
    const files = ['/etc/profile', '/h/.profile', '/h/.bashrc']
    expect(await startupFiles({ home: '/h', login: true, interactive: true }, host(files))).toEqual(['/etc/profile', '/h/.profile', '/h/.bashrc'])
  })

  it('reads nothing for a shell that is neither login nor interactive', async () => {
    expect(await startupFiles({ home: '/h', login: false, interactive: false }, host(['/etc/profile', '/h/.bashrc']))).toEqual([])
  })

  it('skips user files without a home and survives a host that throws', async () => {
    expect(await startupFiles({ login: true, interactive: true }, host(['/etc/profile', '/h/.bashrc']))).toEqual(['/etc/profile'])
    const broken = { isFile: () => { throw new Error('boom') }, list: () => { throw new Error('boom') } }
    expect(await startupFiles({ home: '/h', login: true, interactive: true }, broken)).toEqual([])
  })
})

describe('parseEnvironment', () => {
  it('reads NAME=value lines as pam_env does: comments, export, quotes, no expansion', () => {
    expect(parseEnvironment('# note\nEDITOR=vim\nexport PAGER="less -R"\nQ=\'a b\'\nEMPTY=\nPATH_X=$HOME/bin\n  \nbad line\n1X=no\n'))
      .toEqual({ EDITOR: 'vim', PAGER: 'less -R', Q: 'a b', EMPTY: '', PATH_X: '$HOME/bin' })
  })
})
