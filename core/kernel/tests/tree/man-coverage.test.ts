import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = join(__dirname, '..', '..')
const docs = join(here, 'public/initfs/usr/share/docs/@ecmaos')

const { existsSync, readdirSync, readFileSync } = process.getBuiltinModule('node:fs')

/** The program names a directory of `.mjs` commands holds. */
const commands = (dir: string) => readdirSync(dir).filter(file => file.endsWith('.mjs')).map(file => file.slice(0, -4))

/** The programs a package's `programs/manifest.json` lists. */
const programs = (dir: string) => Object.keys(JSON.parse(readFileSync(join(dir, 'programs/manifest.json'), 'utf8')).programs)

/**
 * A page lives in the package that ships the program: `kernel/commands` for the commands the kernel itself provides,
 * `coreutils` for `@ecmaos/coreutils` (its JavaScript commands and its WebAssembly programs) and `coreutils-copyleft`
 * for `@ecmaos/coreutils-copyleft`. `man <name>` looks in all three.
 */
describe('man page coverage', () => {
  const packages: [string, string[]][] = [
    ['kernel/commands', commands(join(here, 'src/bin/commands'))],
    ['coreutils', [...commands(join(here, '..', 'utils/src/commands-execve')), ...programs(join(here, '..', 'utils'))]],
    ['coreutils-copyleft', programs(join(here, '..', 'utils-copyleft'))]
  ]

  for (const [dir, names] of packages) {
    it(`has a page in @ecmaos/${dir} for every program it ships`, () => {
      expect(names.filter(name => !existsSync(join(docs, dir, `${name}.md`)))).toEqual([])
    })
  }

  it('has each page in one package only, and its first line names that package', () => {
    const seen = new Map<string, string>()
    const wrong: string[] = []
    for (const [dir] of packages) {
      for (const file of readdirSync(join(docs, dir)).filter(name => name.endsWith('.md'))) {
        const name = file.slice(0, -3)
        if (seen.has(name)) wrong.push(`${name} is in ${seen.get(name)} and ${dir}`)
        seen.set(name, dir)
        if (!readFileSync(join(docs, dir, file), 'utf8').includes(`\`man @ecmaos/${dir}/${name}\``)) wrong.push(`${dir}/${name} names another package`)
      }
    }
    expect(wrong).toEqual([])
  })
})
