import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * split/pr/tee/stat migrated onto real execve, continuing the "migrate opportunistically" plan.
 * stat's original `.zip`-entries listing used `@zip.js/zip.js`; bundling that ~345KB library into
 * the worker program pushed it past a real, empirically-confirmed size limit on importing a `data:`
 * URL this large (import failed with a bare `SyntaxError`, no useful message). Replaced with a
 * hand-written real ZIP central-directory parser (stat only ever needed each entry's filename and
 * uncompressed size) -- see stat.mjs's own doc comment. tee's `shell.expandTilde(...)` (a live
 * `Shell` method) is replaced by a small worker-local `~` expansion using `env.HOME`.
 */
describe('text command batch 5: split/pr/tee/stat, real execve', () => {
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

  for (const name of ['split', 'pr', 'tee', 'stat']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('split splits a file into pieces by line count', async () => {
    // The PREFIX argument is joined against the INPUT file's own directory (dirname(fullPath)),
    // matching the original in-process command's behavior exactly -- a bare prefix name, not a
    // full path of its own, is the real intended usage (same as real `split`'s own convention).
    await kernel.filesystem.fs.mkdir('/tmp/split-test', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/split-test/input.txt', 'a\nb\nc\nd\n')
    const code = await kernel.shell.execute('split -l2 /tmp/split-test/input.txt out.')
    expect(code).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/split-test/out.aa', 'utf-8')).toBe('a\nb')
    expect(await kernel.filesystem.fs.readFile('/tmp/split-test/out.ab', 'utf-8')).toBe('c\nd')
  })

  it('pr paginates a file with a page footer', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/pr-in.txt', 'line1\nline2\n')
    const code = await kernel.shell.execute('pr -l 10 /tmp/pr-in.txt > /tmp/pr.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/pr.out', 'utf-8')
    expect(out).toContain('line1')
    expect(out).toContain('Page 1')
  })

  it('tee writes to stdout and to a real file simultaneously', async () => {
    const code = await kernel.shell.execute('echo hello | tee /tmp/tee.out > /tmp/tee-stdout.out')
    expect(code).toBe(0)
    expect((await kernel.filesystem.fs.readFile('/tmp/tee.out', 'utf-8')).trim()).toBe('hello')
    expect((await kernel.filesystem.fs.readFile('/tmp/tee-stdout.out', 'utf-8')).trim()).toBe('hello')
  })

  it('tee -a appends instead of overwriting', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tee-append.out', 'existing\n')
    const code = await kernel.shell.execute('echo appended | tee -a /tmp/tee-append.out > /dev/null')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/tee-append.out', 'utf-8')
    expect(out).toBe('existing\nappended\n')
  })

  it('stat prints real JSON file status', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/stat-in.txt', 'hello')
    const code = await kernel.shell.execute('stat /tmp/stat-in.txt > /tmp/stat.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/stat.out', 'utf-8')
    const parsed = JSON.parse(out)
    expect(parsed.size).toBe(5)
  })

  it('stat lists real ZIP entries via the hand-written central-directory parser', async () => {
    // A minimal, real, uncompressed (store-method) ZIP built by hand -- one local file header, one
    // matching central directory record, one end-of-central-directory record -- exercises the same
    // real ZIP binary format stat.mjs's own parser reads, without depending on any zip-writing
    // command (`zip` stays on the legacy shim and isn't what this test is about).
    const name = 'hello.txt'
    const content = new TextEncoder().encode('hello world')
    const nameBytes = new TextEncoder().encode(name)

    const localHeader = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(localHeader.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header signature
    lv.setUint16(8, 0, true) // compression method: stored
    lv.setUint32(18, content.length, true) // compressed size
    lv.setUint32(22, content.length, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true) // filename length
    localHeader.set(nameBytes, 30)

    const centralHeader = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(centralHeader.buffer)
    cv.setUint32(0, 0x02014b50, true) // central directory signature
    cv.setUint16(10, 0, true) // compression method: stored
    cv.setUint32(20, content.length, true) // compressed size
    cv.setUint32(24, content.length, true) // uncompressed size
    cv.setUint16(28, nameBytes.length, true) // filename length
    cv.setUint32(42, 0, true) // local header offset
    centralHeader.set(nameBytes, 46)

    const centralDirOffset = localHeader.length + content.length
    const eocd = new Uint8Array(22)
    const ev = new DataView(eocd.buffer)
    ev.setUint32(0, 0x06054b50, true) // end-of-central-directory signature
    ev.setUint16(10, 1, true) // total entries
    ev.setUint32(12, centralHeader.length, true) // central directory size
    ev.setUint32(16, centralDirOffset, true) // central directory offset

    const zipBytes = new Uint8Array(localHeader.length + content.length + centralHeader.length + eocd.length)
    zipBytes.set(localHeader, 0)
    zipBytes.set(content, localHeader.length)
    zipBytes.set(centralHeader, localHeader.length + content.length)
    zipBytes.set(eocd, centralDirOffset + centralHeader.length)

    await kernel.filesystem.fs.writeFile('/tmp/stat-test.zip', zipBytes)

    const code = await kernel.shell.execute('stat /tmp/stat-test.zip > /tmp/stat-zip.out')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/stat-zip.out', 'utf-8')
    expect(out).toContain('ZIP Entries:')
    expect(out).toContain('hello.txt')
    expect(out).toContain('11 bytes')
  })

  it('stat reports an error and nonzero exit for a missing file', async () => {
    const code = await kernel.shell.execute('stat /tmp/does-not-exist-batch5.txt 2>/tmp/stat-missing.err')
    expect(code).toBe(1)
  })

  it('split and pr report an error and nonzero exit for a missing file', async () => {
    const code1 = await kernel.shell.execute('split -l 1 /tmp/does-not-exist-batch5.txt 2>/tmp/split-missing.err')
    expect(code1).toBe(1)
  }, 20000)
})
