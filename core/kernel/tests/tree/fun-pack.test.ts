import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

const { readdirSync, readFileSync } = process.getBuiltinModule('node:fs')

/** cowsay, figlet, fortune, lolcat, sl and cmatrix: the terminal's toys */
describe('the fun pack', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_ALL })
    await kernel.boot()
    await kernel.whenProgramsReady()
    // the initfs is not unpacked in a test: put the cows it would hold where the machine has them
    const cows = `${process.cwd()}/public/initfs/usr/share/cows`
    await fs().mkdir('/usr/share/cows', { recursive: true })
    for (const cow of readdirSync(cows)) await fs().writeFile(`/usr/share/cows/${cow}`, readFileSync(`${cows}/${cow}`, 'utf8'))
  }, 120_000)

  it('cowsay and cowthink draw a balloon and a cow, from arguments or standard input', async () => {
    const said = await run('cowsay Hello')
    expect(said.code).toBe(0)
    expect(said.out.split('\n').slice(0, 5)).toEqual([' _______', '< Hello >', ' -------', '        \\', '         \\   (__)'])
    const thought = await run('echo "a b c" | cowthink -d -f owl')
    expect(thought.out).toContain('( a b c )')
    expect(thought.out).toContain('{xx}')
    const wrapped = await run('cowsay -W 10 one two three four')
    expect(wrapped.out.split('\n').slice(1, 4)).toEqual(['/ one two \\', '| three   |', '\\ four    /'])
    expect((await run('cowsay -l')).out).toMatch(/default.*owl/s)
    expect((await run('cowsay -f nosuchcow hi')).code).toBe(1)
  }, 60_000)

  it('figlet draws large letters in its fonts', async () => {
    const big = await run('figlet Hi')
    expect(big.code).toBe(0)
    expect(big.out).toBe(' _   _ _ \n| | | (_)\n| |_| | |\n|  _  | |\n|_| |_|_|\n         \n')
    expect((await run('figlet -f slant Hi')).out).toContain('/ /_/ /')
    expect((await run('figlet -I2')).out).toBe('/usr/share/figlet\n')
  }, 60_000)

  it('fortune picks a cookie from the installed files', async () => {
    const one = await run('fortune')
    expect(one.code).toBe(0)
    expect(one.out.trim().length).toBeGreaterThan(0)
    const files = await run('fortune -f')
    expect(files.out + files.err).toMatch(/linux/)
    expect((await run('fortune -c computers')).out).toMatch(/^\(\/usr\/share\/games\/fortunes\/computers\)\n%\n/)
  }, 60_000)

  it('lolcat colours its input', async () => {
    const coloured = await run('echo rainbow | lolcat -f')
    expect(coloured.code).toBe(0)
    expect(coloured.out).toMatch(/\x1b\[38;5;\d+mr/)
    expect((await run('echo plain | lolcat')).out).toBe('plain\n')
  }, 60_000)

  it('sl drives a train across, and cmatrix draws until it is stopped', async () => {
    const train = await run('sl -l < /dev/null')
    expect(train.code).toBe(0)
    expect(train.out).toContain('\x1b[')
    const matrix = await run('timeout 2 cmatrix < /dev/null')
    expect(matrix.code).toBe(124)
    expect(matrix.out).toContain('\x1b[')
  }, 60_000)
})
