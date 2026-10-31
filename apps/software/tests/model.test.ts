import { describe, expect, it } from 'vitest'

import { Software, installCommand, quote, reason, removeCommand } from '../src/model.js'

describe('the commands the window runs', () => {
  it('installs for me as the caller, and for everyone behind sudo with the password from a file', () => {
    expect(installCommand('@ecmaos-apps/vim', 'me', false)).toBe(`install '@ecmaos-apps/vim'`)
    expect(installCommand('@ecmaos-apps/vim', 'me', true)).toBe(`install -g '@ecmaos-apps/vim'`)
    expect(installCommand('vim', 'everyone', true)).toBe(`install -g 'vim'`)
    expect(installCommand('vim', 'everyone', false, '/tmp/.pw')).toBe(`sudo -S -p '' install -g 'vim' < '/tmp/.pw'`)
    expect(() => installCommand('vim', 'everyone', false)).toThrow(/password/)
  })

  it('removes from where the package is', () => {
    expect(removeCommand('vim', false, false)).toBe(`install remove 'vim'`)
    expect(removeCommand('vim', true, true)).toBe(`install -g remove 'vim'`)
    expect(removeCommand('vim', true, false, '/tmp/.pw')).toContain(`sudo -S`)
  })

  it('never puts anything but a package name on a command line', () => {
    for (const bad of ['vim; rm -rf /', '$(id)', 'a b', '', '../x', "x'y"]) expect(() => installCommand(bad, 'me', false), bad).toThrow(/not a package name/)
    expect(quote("it's")).toBe(`'it'\\''s'`)
  })

  it('reads the JSON, and says why when there is none', async () => {
    const software = new Software(async command => command.startsWith('software list')
      ? { code: 0, out: JSON.stringify({ categories: [{ name: 'System', collections: [] }] }), err: '' }
      : { code: 1, out: '', err: '\u001b[31mnpm error: nope\u001b[0m\n' })
    expect((await software.explore())[0]?.name).toBe('System')
    await expect(software.installed()).rejects.toThrow('npm error: nope')
    expect(reason({ code: 2, out: '', err: '' })).toBe('exited with 2')
  })

  it('searches the registry only when asked, and an empty answer is still an answer', async () => {
    const seen: string[] = []
    const software = new Software(async command => { seen.push(command); return { code: 1, out: JSON.stringify({ results: [], npm: [{ name: 'x', package: 'x' }] }), err: '' } })
    expect((await software.search("it's", true)).npm).toHaveLength(1)
    await software.search('vim', false)
    expect(seen).toEqual([`software search --npm --json 'it'\\''s'`, `software search --json 'vim'`])
  })
})
