import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * A real POSIX `#!` line naming an interpreter.
 *
 * `Kernel.readFileHeader` used to recognize only `#!ecmaos:<type>:<ns>:<name>` and the literal
 * `#!/usr/bin/env node`. Anything else returned `null`, fell through to `checkExtensionType`, came
 * back as `application/octet-stream`, and matched no case in `Kernel.execute`'s switch -- so a file
 * starting `#!/bin/node` exited `-1` with no output and no diagnostic at all.
 *
 * ecmaOS does not parse the shebang itself: `@zenfs/linux`'s `binfmt_script` already implements the
 * real rule (rewrite argv to `[interpreter, arg?, filename, ...rest]`, re-search the binfmt table,
 * bounded chain depth, `ENOEXEC` on a truncated line). Classifying such a file as `interpreter`
 * routes it to `executeViaExecve`, which hands the path to upstream `execve` untouched.
 */
describe('POSIX #! interpreter dispatch', () => {
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

  it('classifies an arbitrary shebang as an interpreter rather than returning null', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/shebang-classify', '#!/bin/node\nconsole.log(1)\n', { mode: 0o755 })
    const header = await kernel.readFileHeader('/tmp/shebang-classify')
    expect(header).toEqual({ type: 'bin', namespace: 'interpreter', name: '/bin/node' })
  })

  it('still recognizes the ecmaos shebang', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/shebang-ecmaos', '#!ecmaos:bin:script:t\necho hi\n', { mode: 0o755 })
    const header = await kernel.readFileHeader('/tmp/shebang-ecmaos')
    expect(header).toEqual({ type: 'bin', namespace: 'script', name: 't' })
  })

  it('still recognizes /usr/bin/env node', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/shebang-env', '#!/usr/bin/env node\nconsole.log(1)\n', { mode: 0o755 })
    const header = await kernel.readFileHeader('/tmp/shebang-env')
    expect(header).toEqual({ type: 'bin', namespace: 'node', name: 'node' })
  })

  it('ignores whitespace between #! and the interpreter path', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/shebang-spaced', '#!  /bin/node  -x\nconsole.log(1)\n', { mode: 0o755 })
    const header = await kernel.readFileHeader('/tmp/shebang-spaced')
    expect(header?.name).toBe('/bin/node')
  })

  /**
   * End to end through upstream `binfmt_script`: a custom interpreter receives the script's path as
   * its own `argv[1]`, which is the whole contract a `#!` line exists to provide. The interpreter is
   * itself an ordinary JS program, so the chain is script -> `/tmp/shebang-interp.js` -> (binfmt_js)
   * -> `/bin/node`, exercising upstream's re-search rather than a single rewrite.
   *
   * Note that `#!/bin/node` specifically is *not* usable here and is not meant to be: `/bin/node`
   * takes the program to run from its process's `exe`, which upstream's `binfmt_js` already points
   * at the script. Naming it explicitly makes `exe` `/bin/node` itself, so it would load itself.
   * Plain JS needs no shebang at all for this reason -- `binfmt_js` matches it unconditionally.
   */
  it('passes the script path to a custom interpreter as argv[1]', async () => {
    await kernel.filesystem.fs.writeFile(
      '/tmp/shebang-interp.js',
      "const { writeAll, argv } = globalThis.ecmaosSyscalls\n" +
      "writeAll(1, new TextEncoder().encode('interp saw ' + argv[1] + '\\n'))\n",
      { mode: 0o755 }
    )
    await kernel.filesystem.fs.writeFile(
      '/tmp/shebang-payload',
      '#!/tmp/shebang-interp.js\nignored payload body\n',
      { mode: 0o755 }
    )

    const code = await kernel.shell.execute('/tmp/shebang-payload > /tmp/shebang-run.out')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/shebang-run.out', 'utf-8')).toBe('interp saw /tmp/shebang-payload\n')
  })

  it('fails loudly, not silently, when the interpreter does not exist', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/shebang-missing', '#!/bin/definitely-not-here\necho hi\n', { mode: 0o755 })
    const code = await kernel.shell.execute('/tmp/shebang-missing')
    // The point is that this is a reported failure from a real `execve`, not the old silent `-1`
    // produced by a switch statement with no matching case.
    expect(code).not.toBe(0)
  })
})
