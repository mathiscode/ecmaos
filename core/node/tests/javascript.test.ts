import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

describe.skipIf(!supported)('JavaScript programs', () => {
  const session = new Session(['--quiet', '--ephemeral'])

  beforeAll(async () => {
    await session.ready()
    await session.run(`echo "console.log('ARGV', JSON.stringify(globalThis.ecmaosSyscalls.argv))" > /root/show.js`)
    for (const extension of ['mjs', 'cjs']) await session.run(`cp /root/show.js /root/show.${extension}`)
    await session.run('chmod +x /root/show.js /root/show.mjs /root/show.cjs')
  })
  afterAll(async () => { await session.stop() })

  it.each(['js', 'mjs', 'cjs'])('runs a .%s file by its path', async extension => {
    expect(await session.run(`/root/show.${extension} one two`)).toBe(`ARGV ["/root/show.${extension}","one","two"]`)
  })

  it('runs `node file args`, with the file as argv[0]', async () => {
    expect(await session.run('node /root/show.mjs a b')).toBe('ARGV ["/root/show.mjs","a","b"]')
    expect(await session.run('cd /root && node show.js rel')).toBe('ARGV ["/root/show.js","rel"]')
  })

  it('fails `node` with a message and a status, not a hang', async () => {
    expect(await session.run('node /root/missing.js; echo status=$?')).toMatch(/^node: \/root\/missing\.js: .*\nstatus=1$/)
    expect(await session.run('node; echo status=$?')).toBe('usage: node <file> [args...]\nstatus=1')
    expect(await session.run('node --version; echo status=$?')).toBe('node: --version: unsupported option\nstatus=9')
  })
})
