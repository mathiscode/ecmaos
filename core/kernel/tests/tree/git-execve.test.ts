import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * git as a real execve program: isomorphic-git running in a worker over an fs.promises adapter that
 * sits on the raw filesystem syscalls. Covers the local workflow end to end; clone/push/pull/fetch
 * share the same adapter and only add the library's plain-fetch http client, so they are not
 * exercised here (no network in tests).
 */
describe('git, real execve', () => {
  let kernel: Kernel
  const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf-8')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/git.out 2> /tmp/git.err`)
    return { code, out: await read('/tmp/git.out'), err: await read('/tmp/git.err').catch(() => '') }
  }

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

  it('is a real execve file, not the legacy stub', async () => {
    expect((await read('/bin/git')).startsWith('#!ecmaos:bin:command:')).toBe(false)
  })

  it('runs init, add, commit, status, log, branch, checkout, config, remote and rm', { timeout: 60000 }, async () => {
    await kernel.filesystem.fs.mkdir('/tmp/repo/sub', { recursive: true })

    let r = await run('cd /tmp/repo && git init')
    expect(r.err).toBe('')
    expect(r.out).toContain('Initialized empty Git repository in /tmp/repo/.git/')

    await kernel.filesystem.fs.writeFile('/tmp/repo/a.txt', 'one')
    await kernel.filesystem.fs.writeFile('/tmp/repo/sub/b.txt', 'two')

    r = await run('cd /tmp/repo && git status')
    expect(r.out).toContain('untracked:  a.txt sub/b.txt')

    // add from a subdirectory still resolves the repo root and stages a directory recursively
    expect((await run('cd /tmp/repo/sub && git add . ../a.txt')).code).toBe(0)
    r = await run('cd /tmp/repo && git status')
    expect(r.out).toContain('new file:   a.txt sub/b.txt')

    r = await run('cd /tmp/repo && git commit -m "first commit"')
    expect(r.err).toBe('')
    expect(r.out).toMatch(/^\[[0-9a-f]{7}\] first commit/)

    r = await run('cd /tmp/repo && git status')
    expect(r.out).toContain('nothing to commit, working tree clean')

    await kernel.filesystem.fs.writeFile('/tmp/repo/a.txt', 'one changed')
    r = await run('cd /tmp/repo && git status')
    expect(r.out).toContain('modified:   a.txt')
    r = await run('cd /tmp/repo && git diff a.txt')
    expect(r.out).toContain('diff --git a/a.txt b/a.txt')

    r = await run('cd /tmp/repo && git log --oneline')
    expect(r.out).toMatch(/^[0-9a-f]{7} first commit/)
    r = await run('cd /tmp/repo && git log')
    expect(r.out).toContain('Author: root <root@')
    expect(r.out).toContain('    first commit')

    expect((await run('cd /tmp/repo && git branch feature')).out).toContain("Created branch 'feature'")
    r = await run('cd /tmp/repo && git branch')
    expect(r.out).toContain('feature')
    expect(r.out).toMatch(/\* (main|master)/)
    // a non-forced checkout keeps local modifications rather than clobbering them
    expect((await run('cd /tmp/repo && git checkout feature')).out).toContain("Switched to branch 'feature'")
    expect(await read('/tmp/repo/a.txt')).toBe('one changed')

    expect((await run('cd /tmp/repo && git config user.name mathis')).code).toBe(0)
    expect((await run('cd /tmp/repo && git config user.name')).out.trim()).toBe('mathis')

    expect((await run('cd /tmp/repo && git remote add origin git@github.com:o/r.git')).code).toBe(0)
    r = await run('cd /tmp/repo && git remote -v')
    expect(r.out).toContain('origin\thttps://github.com/o/r.git (fetch)')
    expect((await run('cd /tmp/repo && git remote remove origin')).code).toBe(0)
    expect((await run('cd /tmp/repo && git remote')).out).toBe('')

    expect((await run('cd /tmp/repo && git rm sub/b.txt')).code).toBe(0)
    // as before the migration, rm only unstages (isomorphic-git's remove); the working file stays
    expect(await kernel.filesystem.fs.exists('/tmp/repo/sub/b.txt')).toBe(true)
  })

  it('reports errors with the real fatal message and a nonzero exit code', async () => {
    let r = await run('cd /tmp && git status')
    expect(r.code).toBe(1)
    expect(r.err).toContain('fatal: not a git repository')

    r = await run('cd /tmp && git frobnicate')
    expect(r.code).toBe(1)
    expect(r.err).toContain("'frobnicate' is not a git command")

    r = await run('cd /tmp/repo && git commit')
    expect(r.code).toBe(1)
    expect(r.err).toContain('empty commit message')
  })
})
