import { beforeAll, describe, expect, it } from 'vitest'
import { packTar } from 'modern-tar'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * tar migrated onto real execve, using modern-tar's buffered packTar/unpackTar API (whole-archive-
 * in-memory) rather than its streaming createTarPacker/createTarDecoder API, per the confirmed
 * decision in tar.mjs's doc comment -- the library bundles to only ~13KB either way (no bundle-size
 * risk like zip.js had), but the buffered path avoids this migration's first untested reliance on
 * WritableStream.getWriter()/TransformStream inside a worker program.
 */
describe('text command batch 12: tar, real execve', () => {
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

  it('tar is a real execve file, not the legacy stub', async () => {
    const content = await kernel.filesystem.fs.readFile('/bin/tar', 'utf-8')
    expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('creates an archive from a directory and lists its contents', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/tar-src', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/tar-src/a.txt', 'hello')
    await kernel.filesystem.fs.writeFile('/tmp/tar-src/b.txt', 'world')

    // -C only applies to extraction in this port (matching the original -- it never referenced
    // options.directory during create either), so creating from cwd instead of passing -C here.
    const createCode = await kernel.shell.execute('cd /tmp && tar -cf /tmp/tar-archive.tar tar-src')
    expect(createCode).toBe(0)

    const listCode = await kernel.shell.execute('tar -tf /tmp/tar-archive.tar > /tmp/tar-list.out')
    expect(listCode).toBe(0)
    const listing = await kernel.filesystem.fs.readFile('/tmp/tar-list.out', 'utf-8')
    expect(listing).toContain('tar-src/')
    expect(listing).toContain('tar-src/a.txt')
    expect(listing).toContain('tar-src/b.txt')
  })

  it('extracts an archive and restores real file contents', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/tar-extract-src', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/tar-extract-src/file1.txt', 'content one')

    const createCode = await kernel.shell.execute('cd /tmp && tar -cf /tmp/tar-extract.tar tar-extract-src')
    expect(createCode).toBe(0)

    await kernel.filesystem.fs.mkdir('/tmp/tar-extract-dest', { recursive: true })
    const extractCode = await kernel.shell.execute('tar -xf /tmp/tar-extract.tar -C /tmp/tar-extract-dest')
    expect(extractCode).toBe(0)

    const content = await kernel.filesystem.fs.readFile('/tmp/tar-extract-dest/tar-extract-src/file1.txt', 'utf-8')
    expect(content).toBe('content one')
  })

  it('round-trips through gzip with -z', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/tar-gz-src', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/tar-gz-src/gz.txt', 'gzipped content')

    const createCode = await kernel.shell.execute('cd /tmp && tar -czf /tmp/tar-gz.tar.gz tar-gz-src')
    expect(createCode).toBe(0)

    await kernel.filesystem.fs.mkdir('/tmp/tar-gz-dest', { recursive: true })
    const extractCode = await kernel.shell.execute('tar -xzf /tmp/tar-gz.tar.gz -C /tmp/tar-gz-dest')
    expect(extractCode).toBe(0)

    const content = await kernel.filesystem.fs.readFile('/tmp/tar-gz-dest/tar-gz-src/gz.txt', 'utf-8')
    expect(content).toBe('gzipped content')
  })

  it('extracts a multi-level nested path with no intermediate directory entries, matching real npm tarballs', async () => {
    // Reproduces a real regression: extraction's mkdir was a raw single-level mkdir(2) with no
    // recursive-creation of its own. tar.mjs's own `-c` always emits a directory entry for every
    // level, so a plain create/extract round trip through this same tar never exposed the bug --
    // but a real npm package tarball (built by npm's own packer, not this one) commonly emits ONLY
    // file entries, no directory entries at all, for nested paths like dist/assets/foo.js. This
    // built the archive by hand via modern-tar's packTar directly, with file-only entries, to match
    // that real-world layout and actually exercise the ENOENT this fix addresses.
    const fileBody = new TextEncoder().encode('nested content')
    const archiveBytes = await packTar([
      { header: { name: 'pkg/dist/assets/foo.js', type: 'file', size: fileBody.length }, body: fileBody }
    ])
    await kernel.filesystem.fs.writeFile('/tmp/tar-nodirs.tar', Buffer.from(archiveBytes))

    await kernel.filesystem.fs.mkdir('/tmp/tar-nodirs-dest', { recursive: true })
    const extractCode = await kernel.shell.execute('tar -xf /tmp/tar-nodirs.tar -C /tmp/tar-nodirs-dest 2>/tmp/tar-nodirs.err')
    expect(extractCode).toBe(0)

    const content = await kernel.filesystem.fs.readFile('/tmp/tar-nodirs-dest/pkg/dist/assets/foo.js', 'utf-8')
    expect(content).toBe('nested content')
  })

  it('errors when no operation mode is specified', async () => {
    const code = await kernel.shell.execute('tar -f /tmp/tar-noop.tar 2>/tmp/tar-noop.err')
    expect(code).toBe(1)
  })

  it('errors when create is missing a file argument', async () => {
    const code = await kernel.shell.execute('tar -c 2>/tmp/tar-nofile.err')
    expect(code).toBe(1)
  })

  it('errors extracting a nonexistent archive', async () => {
    const code = await kernel.shell.execute('tar -xf /tmp/tar-does-not-exist.tar 2>/tmp/tar-missing.err')
    expect(code).toBe(1)
  })
})
