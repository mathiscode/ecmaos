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

  it('fails `node file` with a message and a status, not a hang', async () => {
    expect(await session.run('node /root/missing.js; echo status=$?')).toMatch(/^node: \/root\/missing\.js: .*\nstatus=1$/)
    expect(await session.run('node --bogus; echo status=$?')).toBe('node: bad option: --bogus\nstatus=9')
    expect(await session.run('node -e; echo status=$?')).toBe('node: -e requires an argument\nstatus=9')
  })

  it('answers --version and --help', async () => {
    expect(await session.run('node -v')).toBe(`v${process.versions.node}`)
    expect(await session.run('node --help | head -1')).toBe('Usage: node [options] [script.js] [arguments]')
  })

  it('runs -e and -p, with the arguments after them', async () => {
    expect(await session.run('node -e "console.log(1 + 1)"')).toBe('2')
    expect(await session.run('node -p "[1, 2, 3].map(x => x * 2)"')).toBe('[ 2, 4, 6 ]')
    expect(await session.run('node -pe "\'text\'"')).toBe('text')
    expect(await session.run('node -p "process.argv" one two')).toBe("[ '/bin/node', 'one', 'two' ]")
    expect(await session.run('node --input-type=module -e "console.log(await 6 * 7)"')).toBe('42')
  })

  it('reports an error from -e on stderr with status 1', async () => {
    expect(await session.run('node -e "throw new Error(\'boom\')" 2>&1 | head -1; echo status=$?')).toMatch(/^Error: boom/)
    expect(await session.run('node -e "throw new Error(\'boom\')" 2>/dev/null; echo status=$?')).toBe('status=1')
  })

  it('sends console output to the guest\'s stdout and stderr, so redirection and pipes see it', async () => {
    expect(await session.run('node -e "console.log(\'to-file\')" > /root/out.txt; cat /root/out.txt')).toBe('to-file')
    expect(await session.run('node -e "console.log(\'a\'); console.error(\'b\')" 2>/dev/null')).toBe('a')
    expect(await session.run('node -e "console.log(\'piped\')" | tr a-z A-Z')).toBe('PIPED')
  })

  it('runs a script from standard input', async () => {
    expect(await session.run('echo "console.log(\'from stdin\')" | node')).toBe('from stdin')
    expect(await session.run('echo "console.log(\'dash\')" | node -')).toBe('dash')
  })
})
