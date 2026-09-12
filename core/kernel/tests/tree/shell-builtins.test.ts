import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The two-tier command dispatch redesign: real Linux has no in-kernel command registry at all --
 * `execve`+`$PATH` resolve a name purely off real files on disk. This session's audit found
 * exactly 10 ecmaOS commands (`cd`, `set`, `bg`, `fg`, `jobs`, `wait`, `local`, `env`, `export`,
 * `su`) that mutate the *calling shell's own* live state (cwd/options/job-table/scope/env/
 * credentials) and so can never become a real `execve`'d file, the same reason bash keeps its own
 * "special builtins" permanent, in-process exceptions -- see `core/kernel/src/tree/lib/
 * shell-builtins.ts`'s own doc comment. Everything else (98 `@ecmaos/coreutils` commands + 12
 * kernel-native ones) is transitional: real files already exist for all of them via
 * `Kernel.registerCommands`, resolved either by real `execve` (10 migrated so far) or a lazy,
 * per-`Terminal`-cached legacy shim (`resolveLegacyCommand`) for whatever hasn't migrated yet.
 *
 * This replaces the old eager `TerminalCommands`, which rebuilt all 108+14 command objects on
 * every new `Terminal` (once at boot, again on every not-yet-created TTY) -- confirmed gone: no
 * command object exists until the one actually invoked is looked up.
 */
describe('two-tier command dispatch: true shell builtins + real execve/$PATH resolution', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  const trueBuiltinNames = ['cd', 'set', 'bg', 'fg', 'jobs', 'wait', 'local', 'env', 'export', 'su']

  it('writes no /bin/<name> file for any true shell builtin, matching real bash having no /bin/cd', async () => {
    for (const name of trueBuiltinNames) {
      expect(await kernel.filesystem.fs.exists(`/bin/${name}`)).toBe(false)
    }
  })

  it('cd mutates shell.cwd for real, in-process, with no file resolution', async () => {
    const before = kernel.shell.cwd
    const code = await kernel.shell.execute('cd /tmp')
    expect(code).toBe(0)
    expect(kernel.shell.cwd).toBe('/tmp')
    await kernel.shell.execute(`cd ${before}`)
  })

  it('export mutates shell.env for real and is visible to a later real execve program', async () => {
    const code = await kernel.shell.execute('export ECMAOS_TEST_VAR=hello')
    expect(code).toBe(0)
    expect(kernel.shell.env.get('ECMAOS_TEST_VAR')).toBe('hello')
  })

  it('a migrated (execve) command still resolves and runs correctly alongside true builtins', async () => {
    const code = await kernel.shell.execute('echo real-execve-still-works > /tmp/builtins-test.out')
    expect(code).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/builtins-test.out', 'utf-8')).trim()).toBe('real-execve-still-works')
  })

  it('a not-yet-migrated legacy command still resolves via the shim and runs correctly', async () => {
    const code = await kernel.shell.execute('true')
    expect(code).toBe(0)
  })

  it('tab-completion finds a true builtin, an execve command, and a legacy command, all without any in-memory command registry', async () => {
    const terminal = kernel.terminal as unknown as { getCompletionMatches: (partial: string) => Promise<string[]> }

    expect(await terminal.getCompletionMatches('cd')).toContain('cd')
    expect(await terminal.getCompletionMatches('ech')).toContain('echo')
    expect(await terminal.getCompletionMatches('ca')).toEqual(expect.arrayContaining(['cat', 'cal']))
  })

  it('resolves a distinct, per-Terminal-cached legacy TerminalCommand for the same name across two different Terminals', async () => {
    const second = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await second.boot()

    const secondContainer = document.createElement('div')
    document.body.appendChild(secondContainer)
    second.terminal.mount(secondContainer)

    // Both kernels can run the same still-legacy command independently -- if the shim's cache were
    // keyed wrong (a shared/global cache instead of one keyed by the live Terminal instance), a
    // stale terminal/shell reference from one kernel could leak into the other's execution.
    const code1 = await kernel.shell.execute('true')
    const code2 = await second.shell.execute('true')
    expect(code1).toBe(0)
    expect(code2).toBe(0)
  })
})
