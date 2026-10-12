import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Shell startup files: sourced as scripts at login, so aliases and functions survive. `~/.ecmashrc` is resolved
 * against the logging-in user's home, which requires `HOME` to be set before `loadEnvFile()`.
 */
describe('startup files', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  const shell = () => kernel.shell
  const fs = () => kernel.filesystem.fs

  const FILES = ['/etc/profile', '/etc/profile.d/10-test.sh', '/etc/ecmashrc', '/root/.profile', '/root/.ecmash_profile', '/root/.bash_profile', '/root/.bashrc', '/root/.ecmashrc']

  beforeEach(async () => {
    // The kernel's shell is long-lived and shared across this file, so anything a previous test left
    // behind would show up here as a pass.
    shell().aliases.clear()
    shell().functions.clear()
    for (const [signal] of shell().listTraps()) shell().setTrap(undefined, signal)
    for (const file of FILES) {
      try { await fs().unlink(file) } catch { /* may not exist */ }
    }
  })

  const write = (file: string, text: string) => fs().writeFile(file, text)

  it('reads ~/.bashrc and /etc/profile.d/*.sh, and ~/.bash_profile hides ~/.profile', async () => {
    await fs().mkdir('/etc/profile.d', { recursive: true })
    await write('/etc/profile', 'ORDER=profile\n')
    await write('/etc/profile.d/10-test.sh', 'ORDER=$ORDER:d\n')
    await write('/root/.bash_profile', 'ORDER=$ORDER:bash_profile\n')
    await write('/root/.profile', 'ORDER=$ORDER:profile_hidden\n')
    await write('/root/.bashrc', 'ORDER=$ORDER:bashrc\n')
    await write('/root/.ecmashrc', 'ORDER=$ORDER:rc\n')

    await shell().loadProfile()

    expect(shell().env.get('ORDER')).toBe('profile:d:bash_profile:bashrc:rc')
  })

  it('runs /etc/profile and ~/.ecmashrc, in that order, and keeps what they define', async () => {
    await write('/etc/profile', 'STARTUP_ORDER=profile\nexport FROM_PROFILE=yes\n')
    await write('/root/.ecmashrc', "STARTUP_ORDER=$STARTUP_ORDER:rc\nalias hi='echo hello'\ngreet() { echo greeted; }\n")

    await shell().loadProfile()

    expect(shell().env.get('STARTUP_ORDER')).toBe('profile:rc')
    expect(shell().env.get('FROM_PROFILE')).toBe('yes')
    expect(shell().aliases.get('hi')).toBe('echo hello')
    expect(shell().functions.has('greet')).toBe(true)
  })

  it('reads only the first of ~/.ecmash_profile and ~/.profile', async () => {
    await write('/root/.ecmash_profile', 'WHICH_PROFILE=ecmash\n')
    await write('/root/.profile', 'WHICH_PROFILE=posix\n')

    await shell().loadProfile()

    expect(shell().env.get('WHICH_PROFILE')).toBe('ecmash')
  })

  it('falls back to ~/.profile when ~/.ecmash_profile is absent', async () => {
    await write('/root/.profile', 'WHICH_PROFILE=posix\n')

    await shell().loadProfile()

    expect(shell().env.get('WHICH_PROFILE')).toBe('posix')
  })

  it('does not fire the EXIT trap, so a trap set at startup survives for the session', async () => {
    const OUT = '/tmp/startup-trap.out'
    try { await fs().unlink(OUT) } catch { /* may not exist */ }
    await write('/root/.ecmashrc', `trap 'echo left >> ${OUT}' EXIT\n`)

    await shell().loadProfile()

    expect(await fs().exists(OUT)).toBe(false)
    expect(shell().getTrap('EXIT')).toBe(`echo left >> ${OUT}`)
  })

  it('carries on past a typo, within the file and across files', async () => {
    // A missing command used to throw out of the whole statement tree, so one typo in a startup
    // file silently dropped every line after it. Found by the browser pass for this phase.
    await write('/etc/profile', 'BEFORE_TYPO=yes\nthis-command-does-not-exist\nAFTER_TYPO=yes\n')
    await write('/root/.ecmashrc', 'NEXT_FILE=reached\n')

    await shell().loadProfile()

    expect(shell().env.get('BEFORE_TYPO')).toBe('yes')
    expect(shell().env.get('AFTER_TYPO')).toBe('yes')
    expect(shell().env.get('NEXT_FILE')).toBe('reached')
  })

  it('names the file and line of a missing command in a startup file', async () => {
    await write('/etc/profile', 'A=1\nthis-command-does-not-exist\n')
    await write('/root/.ecmashrc', '')
    const written: string[] = []
    const terminal = shell().terminal as unknown as { write: (text: string) => void }
    const original = terminal.write.bind(terminal)
    terminal.write = (text: string) => { written.push(text); original(text) }
    try { await shell().loadProfile() } finally { terminal.write = original }
    expect(written.join('')).toContain('/etc/profile: line 2: this-command-does-not-exist: command not found')
  })

  it('reports a missing command as exit 127 without ending the script', async () => {
    const OUT = '/tmp/startup-127.out'
    try { await fs().unlink(OUT) } catch { /* may not exist */ }

    await shell().executeScriptText(`this-command-does-not-exist\necho "code=$?" > ${OUT}\n`)

    expect(await fs().readFile(OUT, 'utf-8')).toBe('code=127\n')
  })

  /**
   * `parseEnvFile` dropped a bare `FOO=`, so an env file could not clear an inherited variable: the
   * line looked malformed to it rather than like the empty-string assignment it is.
   */
  it('assigns the empty string for a bare FOO= in an env file', () => {
    expect(shell().parseEnvFile('EMPTY=\nSET=value\n')).toEqual({ EMPTY: '', SET: 'value' })
    expect(shell().parseEnvFile('\n# a comment\nA=1\n')).toEqual({ A: '1' })
  })

  /**
   * A login shell starts in `$HOME`. The cwd used to be restored from `localStorage`, which made `cd`
   * a persistent setting no real shell has, and could never have worked in a worker.
   */
  it('starts in $HOME rather than / or a remembered directory', () => {
    expect(shell().env.get('HOME')).toBe('/root')
    expect(shell().cwd).toBe('/root')
    expect(shell().env.get('PWD')).toBe('/root')
  })
})
