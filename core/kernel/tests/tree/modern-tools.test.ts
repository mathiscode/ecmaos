import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** ripgrep, fd and bat: Rust programs built for WALI, with threads, the terminal's colours and child processes */
describe('rg, fd and bat', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    await fs().mkdir('/tmp/proj/src/deep', { recursive: true })
    await fs().writeFile('/tmp/proj/src/main.rs', 'fn main() {\n    println!("needle here");\n}\n')
    await fs().writeFile('/tmp/proj/src/deep/lib.rs', '// no needle\npub fn x() {}\n')
    await fs().writeFile('/tmp/proj/notes.txt', 'Needle in caps\n')
    await fs().writeFile('/tmp/proj/.gitignore', 'ignored.txt\n')
    await fs().writeFile('/tmp/proj/ignored.txt', 'needle ignored\n')
    await fs().mkdir('/tmp/proj/.git', { recursive: true })
  }, 60_000)

  it('rg searches a tree in parallel, honours .gitignore, and counts', async () => {
    const found = await run('cd /tmp/proj && rg -n needle < /dev/null')
    expect(found.code).toBe(0)
    expect(found.out.split('\n').filter(Boolean).sort()).toEqual(['src/deep/lib.rs:1:// no needle', 'src/main.rs:2:    println!("needle here");'])
    expect((await run('rg -i -c needle /tmp/proj/notes.txt')).out).toBe('1\n')
    expect((await run('rg --files /tmp/proj < /dev/null | sort')).out).toBe('/tmp/proj/notes.txt\n/tmp/proj/src/deep/lib.rs\n/tmp/proj/src/main.rs\n')
    expect((await run('rg nothing-like-this /tmp/proj < /dev/null')).code).toBe(1)
    expect((await run('rg --version')).out).toMatch(/^ripgrep 15\.2\.0/)
  }, 60_000)

  it('fd finds by name, type and extension', async () => {
    expect((await run('cd /tmp/proj && fd -e rs < /dev/null | sort')).out).toBe('src/deep/lib.rs\nsrc/main.rs\n')
    expect((await run('fd -t d . /tmp/proj')).out.trim()).toMatch(/\/tmp\/proj\/src\/(deep\/)?$/m)
    expect((await run('cd /tmp/proj && fd -H -I ignored')).out).toBe('ignored.txt\n')
    expect((await run('cd /tmp/proj && fd -e rs -x wc -l < /dev/null | sort')).out).toMatch(/2 \.\/src\/deep\/lib\.rs|2 src\/deep\/lib\.rs/)
  }, 60_000)

  it('bat highlights, numbers lines, and shows plain text when piped', async () => {
    const coloured = await run('bat --color=always -p /tmp/proj/src/main.rs')
    expect(coloured.code).toBe(0)
    expect(coloured.out).toMatch(/\x1b\[38;5;\d+mfn/)
    const numbered = await run('bat --decorations=always --style=numbers --color=never /tmp/proj/src/main.rs')
    expect(numbered.out).toBe('   1 fn main() {\n   2     println!("needle here");\n   3 }\n')
    expect((await run('bat /tmp/proj/notes.txt')).out).toBe('Needle in caps\n')
    expect((await run('bat --list-languages')).out).toContain('Rust:rs')
  }, 60_000)
})
