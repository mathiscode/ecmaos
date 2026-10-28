import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The smaller coreutils and util-linux tools: truncate, sync, setsid, flock, base32, numfmt, b2sum, sha224sum, tsort,
 * csplit, pstree, fuser, iconv, dos2unix, shred, fallocate, lslocks, inotifywait, arch, users, link, unlink, sum, pathchk.
 */
describe('small tools', () => {
  let kernel: Kernel
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }
  const until = async (check: () => Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await check()) return true; await sleep(50) }
    return false
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    await sleep(100)
  }, 60_000)

  it('truncate sets, extends and shrinks sizes', async () => {
    await fs().writeFile('/tmp/t', 'hello world')
    expect((await run('truncate -s 5 /tmp/t')).code).toBe(0)
    expect(await read('/tmp/t')).toBe('hello')
    await run('truncate -s +3 /tmp/t')
    expect(await read('/tmp/t')).toBe('hello\0\0\0')
    await run('truncate -s %16 /tmp/t')
    expect((await fs().stat('/tmp/t')).size).toBe(16)
    await run('truncate -s 1K /tmp/new')
    expect((await fs().stat('/tmp/new')).size).toBe(1024)
    expect((await run('truncate -c -s 1 /tmp/nope')).code).toBe(0)
    expect(await fs().exists('/tmp/nope')).toBe(false)
  })

  it('sync and setsid run', async () => {
    await fs().writeFile('/tmp/s', 'x')
    expect((await run('sync')).code).toBe(0)
    expect((await run('sync /tmp/s')).code).toBe(0)
    expect((await run('setsid -w /bin/ecmash -c "exit 4"')).code).toBe(4)
  })

  it('flock runs a command holding a lock, and -n gives up while another holds it', async () => {
    expect((await run('flock /tmp/lockfile echo locked')).out).toBe('locked\n')
    await kernel.shell.execute('flock /tmp/lockfile sleep 3 &')
    await sleep(800)
    const busy = await run('flock -n /tmp/lockfile echo no')
    expect(busy.code).toBe(1)
    expect(busy.out).toBe('')
    expect((await run('lslocks --noheadings -o COMMAND,TYPE,MODE,PATH')).out).toMatch(/flock\s+POSIX\s+WRITE\s+\/tmp\/lockfile/)
    expect((await run('flock -w 5 /tmp/lockfile echo waited')).out).toBe('waited\n')
    expect((await run('flock 9')).code).toBe(64)
  }, 30_000)

  it('base32, sha224sum, b2sum and sum give GNU\'s answers', async () => {
    await fs().writeFile('/tmp/hello', 'hello world!')
    expect((await run('base32 /tmp/hello')).out).toBe('NBSWY3DPEB3W64TMMQQQ====\n')
    expect((await run('base32 /tmp/hello | base32 -d')).out).toBe('hello world!')
    expect((await run('printf abc | sha224sum')).out).toBe('23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7  -\n')
    expect((await run('printf abc | b2sum')).out).toBe('ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923  -\n')
    expect((await run('printf "hello\\n" | sum')).out).toBe('36979     1\n')
  })

  it('numfmt scales numbers as GNU does', async () => {
    expect((await run('numfmt --to=si 1000 1500 123456 9999 999999')).out).toBe('1.0k\n1.5k\n124k\n10k\n1.0M\n')
    expect((await run('numfmt --to=iec-i 2048')).out).toBe('2.0Ki\n')
    expect((await run('numfmt --from=iec 1.5M')).out).toBe('1572864\n')
    expect((await run('printf "a,123456,x\\n" | numfmt -d, --field=2 --to=si')).out).toBe('a,124k,x\n')
    expect((await run('numfmt foo')).code).toBe(2)
  })

  it('tsort and csplit', async () => {
    expect((await run('printf "a b\\nb c\\nx y\\n" | tsort')).out).toBe('a\nx\nb\ny\nc\n')
    await fs().writeFile('/tmp/sec', 'a\nSEC 1\nb\nSEC 2\nc\n')
    const split = await run('cd /tmp && csplit -f part sec /SEC/ {*}')
    expect(split.out).toBe('2\n8\n8\n')
    expect(await read('/tmp/part01')).toBe('SEC 1\nb\n')
    expect((await run('cd /tmp && csplit -f gone sec /nomatch/')).err).toBe("csplit: ‘/nomatch/’: match not found\n")
    expect(await fs().exists('/tmp/gone00')).toBe(false)
  })

  it('pstree and fuser read the process table', async () => {
    const tree = await run('pstree -p')
    expect(tree.out).toMatch(/^init\(1\)/)
    expect(tree.out).toContain('crond(')
    expect((await run('pstree -A')).out).toMatch(/^init-/)
    await fs().writeFile('/tmp/held', '')
    await kernel.shell.execute('flock /tmp/held sleep 2 &')
    await sleep(500)
    const users = await run('fuser /tmp/held')
    expect(users.code).toBe(0)
    expect(users.out).toMatch(/^\s+\d+$/)
    expect(users.err).toBe('/tmp/held:\n')
    expect((await run('fuser /tmp/out-of-use-file-xyz')).code).toBe(1)
  }, 20_000)

  it('iconv converts between encodings', async () => {
    await fs().writeFile('/tmp/utf8', 'café — €5')
    expect((await run('iconv -f UTF-8 -t ISO-8859-1//TRANSLIT /tmp/utf8 | xxd -p')).out).toBe('636166e9202d2d2045555235\n')
    expect((await run('iconv -f utf8 -t utf-16le /tmp/utf8 | iconv -f UTF-16LE -t UTF-8')).out).toBe('café — €5')
    const bad = await run('iconv -f UTF-8 -t ASCII /tmp/utf8')
    expect(bad.code).toBe(1)
    expect(bad.out).toBe('caf')
    expect(bad.err).toBe('iconv: cannot convert at position 3\n')
    expect((await run('iconv -l')).out).toContain('KOI8-R//')
  })

  it('dos2unix and unix2dos change line breaks in place', async () => {
    await fs().writeFile('/tmp/dos', 'a\r\nb\r\n')
    expect((await run('dos2unix /tmp/dos')).err).toBe('dos2unix: converting file /tmp/dos to Unix format...\n')
    expect(await read('/tmp/dos')).toBe('a\nb\n')
    await run('unix2dos -q /tmp/dos')
    expect(await read('/tmp/dos')).toBe('a\r\nb\r\n')
    expect((await run('printf "x\\r\\n" | dos2unix')).out).toBe('x\n')
  })

  it('shred overwrites and removes, fallocate gives and changes space', async () => {
    await fs().writeFile('/tmp/secret', 'top secret data')
    expect((await run('shred -n 1 -z /tmp/secret')).code).toBe(0)
    const shredded = await fs().readFile('/tmp/secret')
    expect(shredded.length).toBe(4096)
    expect(shredded.every((byte: number) => byte === 0)).toBe(true)
    expect((await run('shred -u /tmp/secret')).code).toBe(0)
    expect(await fs().exists('/tmp/secret')).toBe(false)
    expect((await run('fallocate -l 2K /tmp/space')).code).toBe(0)
    expect((await fs().stat('/tmp/space')).size).toBe(2048)
    await fs().writeFile('/tmp/range', 'abcdefgh')
    await run('fallocate -c -o 2 -l 3 /tmp/range')
    expect(await read('/tmp/range')).toBe('abfgh')
    await run('fallocate -p -o 1 -l 2 /tmp/range')
    expect(await read('/tmp/range')).toBe('a\0\0gh')
  })

  it('inotifywait sees a file made and one written', async () => {
    await fs().mkdir('/tmp/watched', { recursive: true })
    const waiting = kernel.shell.execute('inotifywait -q -e create /tmp/watched > /tmp/inotify-out 2>&1')
    await sleep(800)
    await fs().writeFile('/tmp/watched/new.txt', 'x')
    expect(await waiting).toBe(0)
    expect(await read('/tmp/inotify-out')).toBe('/tmp/watched/ CREATE new.txt\n')
    const modified = kernel.shell.execute('inotifywait -q /tmp/watched/new.txt > /tmp/inotify-out 2>&1')
    await sleep(800)
    await kernel.shell.execute('echo more >> /tmp/watched/new.txt')
    expect(await modified).toBe(0)
    expect(await read('/tmp/inotify-out')).toBe('/tmp/watched/new.txt MODIFY \n')
    expect((await run('inotifywait -q -t 1 /tmp/watched')).code).toBe(2)
    expect((await run('inotifywait -e close_write /tmp/watched')).code).toBe(1)
  }, 30_000)

  it('arch, users, link, unlink and pathchk', async () => {
    expect((await run('arch')).out).toBe((await run('uname -m')).out)
    expect((await run('users')).code).toBe(0)
    await fs().writeFile('/tmp/orig', 'o')
    expect((await run('link /tmp/orig /tmp/hard')).code).toBe(0)
    expect(await read('/tmp/hard')).toBe('o')
    expect((await run('unlink /tmp/hard')).code).toBe(0)
    expect(await fs().exists('/tmp/hard')).toBe(false)
    expect(await read('/tmp/orig')).toBe('o')
    // on the persistent root too, and with the original name removed instead
    await fs().writeFile('/root/orig', 'r')
    await run('ln /root/orig /root/hard && unlink /root/orig')
    expect(await fs().exists('/root/orig')).toBe(false)
    expect(await read('/root/hard')).toBe('r')
    expect((await run('pathchk -p "bad name"')).err).toBe("pathchk: nonportable character ' ' in file name 'bad name'\n")
    expect((await run('pathchk /tmp/fine')).code).toBe(0)
  })
})
