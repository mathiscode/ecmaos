import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'
import { copyOfTemplate } from './template.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24
const temp = (name: string) => mkdtempSync(path.join(tmpdir(), `ecmaos-${name}-`))
const clean: string[] = []
const scratch = (name: string) => { const dir = temp(name); clean.push(dir); return dir }
/** A data folder that has booted before, so the test is about what persists and not about the first boot */
const booted = (name: string) => { const dir = copyOfTemplate(`ecmaos-${name}-`); clean.push(dir); return dir }

afterAll(() => { for (const dir of clean) rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(!supported)('the persistent root', () => {
  it('keeps files, modes, owners and symlinks across processes, including a killed one', async () => {
    const data = booted('data')
    const first = new Session(['--quiet'], { env: { ...process.env, ECMAOS_DATA: data } })
    await first.ready()
    await first.run('mkdir -p /root/deep/er && echo persisted > /root/deep/er/file.txt')
    await first.run('chmod 640 /root/deep/er/file.txt && chown 1234:4321 /root/deep/er/file.txt')
    await first.run('ln -s /root/deep/er/file.txt /root/link')
    await first.run('echo marker > /etc/ecmaos-test')
    // No orderly shutdown yet: a SIGKILL is the harshest exit, and what was written must already be on disk
    await first.stop()

    const second = new Session(['--quiet'], { env: { ...process.env, ECMAOS_DATA: data } })
    await second.ready()
    try {
      expect(await second.run('cat /root/deep/er/file.txt')).toBe('persisted')
      expect(await second.run('stat -c "%a %u %g" /root/deep/er/file.txt')).toBe('640 1234 4321')
      expect(await second.run('readlink /root/link')).toBe('/root/deep/er/file.txt')
      expect(await second.run('cat /root/link')).toBe('persisted')
      expect(await second.run('cat /etc/ecmaos-test')).toBe('marker')
    } finally { await second.stop() }
  })

  it('keeps the users it created', async () => {
    const data = booted('users')
    const first = new Session(['--quiet'], { env: { ...process.env, ECMAOS_DATA: data } })
    await first.ready()
    await first.run('useradd -m -p secret alice')
    await first.stop()

    const second = new Session(['--quiet'], { env: { ...process.env, ECMAOS_DATA: data } })
    await second.ready()
    try {
      expect(await second.run('grep alice /etc/passwd')).toMatch(/^alice:/)
      expect(await second.run('grep -c ^alice: /etc/shadow')).toBe('1')
      expect(await second.run('ls /home')).toContain('alice')
    } finally { await second.stop() }
  })

  it('writes nothing outside its data directory', async () => {
    const data = booted('data')
    const cwd = scratch('cwd')
    const home = scratch('home')
    const tmp = scratch('tmp')
    const env = { ...process.env, ECMAOS_DATA: data, HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home }
    mkdirSync(path.join(cwd, 'sub'))

    const session = new Session(['--quiet'], { cwd, env })
    await session.ready()
    await session.run('echo x > /root/x && jq --version && useradd -m -p x bob && vim --version')
    await session.stop()

    expect(readdirSync(cwd)).toEqual(['sub'])
    expect(readdirSync(home)).toEqual([])
    expect(readdirSync(tmp)).toEqual([])
    expect(readdirSync(data).every(name => name.startsWith('root.db'))).toBe(true)
  })

  it('holds a large file', async () => {
    const session = new Session()
    await session.ready()
    try {
      await session.run('dd if=/dev/zero of=/root/big bs=1M count=24 2>/dev/null', 120_000)
      expect(await session.run('stat -c %s /root/big')).toBe(String(24 * 1024 * 1024))
    } finally { await session.stop() }
  }, 180_000)
})
