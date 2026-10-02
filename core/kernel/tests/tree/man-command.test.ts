import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `man <command>` finds a written page for the command, and failing that runs its `--help`, so
 * every command has a manual page.
 */
describe('man', () => {
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

  const run = async (command: string): Promise<{ code: number, out: string }> => {
    const code = await kernel.shell.execute(`${command} > /tmp/man-out.txt 2>&1`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/man-out.txt', 'utf-8') }
  }

  const writePage = async (dir: string, name: string, text: string) => {
    await kernel.filesystem.fs.mkdir(dir, { recursive: true })
    await kernel.filesystem.fs.writeFile(`${dir}/${name}.md`, text)
  }

  it('shows the written page for a kernel command, ahead of its --help', async () => {
    await writePage('/usr/share/docs/@ecmaos/kernel/commands', 'kill', '# kill page\n\nWritten by hand.\n')
    const { code, out } = await run('man kill')
    expect(code).toBe(0)
    expect(out).toContain('Written by hand.')
    expect(out).not.toContain('Usage: kill')
  })

  it('shows the written page for a coreutils command', async () => {
    await writePage('/usr/share/docs/@ecmaos/coreutils', 'wc', '# wc page\n\nCounts things.\n')
    const { code, out } = await run('man wc')
    expect(code).toBe(0)
    expect(out).toContain('Counts things.')
  })

  it('falls back to --help for a command with no page', async () => {
    const { code, out } = await run('man cat')
    expect(code).toBe(0)
    expect(out).toContain('Usage: cat')
    expect(out).toContain('Concatenate')
  })

  it('reports a name that is neither a page nor a command', async () => {
    const { code, out } = await run('man nosuchcommand')
    expect(code).toBe(1)
    expect(out).toContain('no manual entry for nosuchcommand')
  })

  it('still resolves a package path', async () => {
    await writePage('/usr/share/docs/@ecmaos/kernel/commands', 'ps', '# ps page\n\nLists processes.\n')
    const { code, out } = await run('man @ecmaos/kernel/commands/ps')
    expect(code).toBe(0)
    expect(out).toContain('Lists processes.')
  })
})
