import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { SYSTEM_DIRECTORY_MODES, TEMPORARY_DIRECTORIES, tightenDirectoryModes } from '#lib/fs-modes.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** A tiny in-memory stand-in: path to mode, `stat` fails for a path that is not there. */
function fakeFs(modes: Record<string, number>) {
  return {
    modes,
    async stat(path: string) {
      if (!(path in modes)) throw new Error('ENOENT')
      return { mode: 0o040000 | modes[path]! }
    },
    async chmod(path: string, mode: number) { modes[path] = mode }
  }
}

describe('tightenDirectoryModes', () => {
  it('closes a world-writable system directory and leaves others alone', async () => {
    const fs = fakeFs({ '/': 0o777, '/etc': 0o777, '/root': 0o777, '/home': 0o755, '/var/log': 0o700, '/tmp': 0o1777 })
    const changed = await tightenDirectoryModes(fs)
    expect(fs.modes).toMatchObject({ '/': 0o755, '/etc': 0o755, '/root': 0o700, '/home': 0o755, '/var/log': 0o700, '/tmp': 0o1777 })
    expect(changed.sort()).toEqual(['/', '/etc', '/root'])
  })

  it('adds the sticky bit to the temporary directories without removing access', async () => {
    const fs = fakeFs({ '/tmp': 0o777, '/var/tmp': 0o755 })
    expect(await tightenDirectoryModes(fs)).toEqual(['/tmp', '/var/tmp'])
    expect(fs.modes).toEqual({ '/tmp': 0o1777, '/var/tmp': 0o1755 })
  })

  it('is idempotent and skips directories that do not exist', async () => {
    const fs = fakeFs({ '/etc': 0o777 })
    await tightenDirectoryModes(fs)
    expect(await tightenDirectoryModes(fs)).toEqual([])
  })

  it('a directory a user has made group-writable is left as they set it', async () => {
    const fs = fakeFs({ '/opt': 0o775 })
    expect(await tightenDirectoryModes(fs)).toEqual([])
  })
})

describe('a booted kernel', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  }, 60000)

  it('has no world-writable system directory and sticky temporary ones', async () => {
    const mode = async (path: string) => (await kernel.filesystem.fs.stat(path)).mode & 0o7777
    for (const [path, want] of Object.entries(SYSTEM_DIRECTORY_MODES)) {
      if (!await kernel.filesystem.fs.exists(path)) continue
      expect(await mode(path), path).toBe(want)
    }
    for (const path of TEMPORARY_DIRECTORIES) expect(await mode(path) & 0o1000, path).toBe(0o1000)
    expect(await mode('/tmp') & 0o777).toBe(0o777)
  })

  it('a file written to /tmp still works for the shell', async () => {
    expect(await kernel.shell.execute('echo hi > /tmp/modes-check')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/modes-check', 'utf-8')).toBe('hi\n')
  })
})
