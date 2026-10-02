import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = join(__dirname, '..', '..')
const pages = join(here, 'public/initfs/usr/share/docs/@ecmaos/kernel/commands')
const sources = [join(here, 'src/bin/commands'), join(here, '..', 'utils/src/commands-execve')]

const { existsSync, readdirSync } = process.getBuiltinModule('node:fs')

describe('man page coverage', () => {
  it('has a page for every command program', () => {
    const missing: string[] = []
    for (const dir of sources) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.mjs')) continue
        const name = file.slice(0, -4)
        if (!existsSync(join(pages, `${name}.md`))) missing.push(name)
      }
    }
    expect(missing).toEqual([])
  })
})
