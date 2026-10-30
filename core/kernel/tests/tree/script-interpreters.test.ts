import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('what scripts expect to find', () => {
  let kernel: Kernel
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    const read = (name: string) => kernel.filesystem.fs.readFile(`/tmp/${name}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }
  const script = async (name: string, text: string) => {
    await kernel.filesystem.fs.writeFile(`/tmp/${name}`, text, { mode: 0o755 })
    return `/tmp/${name}`
  }

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
    await new Promise(r => setTimeout(r, 1500))
  }, 60000)

  it('/bin/sh and /usr/bin/env are links, and /bin/bash is not the shell\'s', async () => {
    expect(await kernel.filesystem.fs.exists('/bin/bash')).toBe(false)
    for (const path of ['/bin/sh', '/usr/bin/env']) {
      expect((await kernel.filesystem.fs.lstat(path)).isSymbolicLink(), path).toBe(true)
      expect(await kernel.filesystem.fs.exists(path), path).toBe(true)
    }
  })

  it.each(['#!/bin/sh', '#!/usr/bin/env sh'])('a script starting %s runs', async (shebang) => {
    const path = await script('interp.sh', `${shebang}\nname=$1\necho hello $name\nexit 3\n`)
    const result = await run(`${path} world`)
    expect(result.out).toBe('hello world\n')
    expect(result.code).toBe(3)
  }, 30000)

  it('sh -c runs a command line', async () => {
    const result = await run('/bin/sh -c "echo a; echo b"')
    expect(result.out).toBe('a\nb\n')
  }, 30000)

  describe('env and printenv', () => {
    it('env runs a command with extra and removed variables', async () => {
      expect((await run('/usr/bin/env GREETING=hi /bin/printenv GREETING')).out).toBe('hi\n')
      expect((await run('/usr/bin/env -u HOME /bin/printenv HOME')).code).toBe(1)
      expect((await run('/usr/bin/env -i FOO=1 /usr/bin/env')).out).toBe('FOO=1\n')
    }, 30000)

    it('env reports a missing command and passes the status on', async () => {
      const missing = await run('/usr/bin/env no-such-command')
      expect(missing.code).toBe(127)
      expect(missing.err).toContain('No such file or directory')
      const path = await script('exit5.sh', '#!/bin/sh\nexit 5\n')
      expect((await run(`/usr/bin/env ${path}`)).code).toBe(5)
    }, 30000)

    it('printenv prints values and fails for what is not set', async () => {
      expect((await run('/bin/printenv HOME')).out).toMatch(/^\/.*\n$/)
      expect((await run('/bin/printenv HOME NO_SUCH_VARIABLE')).code).toBe(1)
      expect((await run('/bin/printenv')).out).toContain('PATH=')
    }, 30000)
  })

  describe('$!', () => {
    it('is the pid of the process just started in the background, usable on the same line', async () => {
      expect(await kernel.shell.execute('sleep 30 & echo $! > /tmp/bg-pid; kill -0 $!; echo status=$? >> /tmp/bg-pid')).toBe(0)
      const [pid, status] = (await kernel.filesystem.fs.readFile('/tmp/bg-pid', 'utf-8')).trim().split('\n')
      expect(status).toBe('status=0')
      expect((await run('/bin/ps -e')).out).toMatch(new RegExp(`^\\s*${pid}\\s`, 'm'))
      await run(`kill -9 ${pid}`)
    }, 30000)
  })

  describe('kill -0', () => {
    it('succeeds for a live process, fails for a missing one, and delivers nothing', async () => {
      await kernel.shell.execute('sleep 30 &')
      const listing = (await run('/bin/ps -e')).out
      const pid = listing.split('\n').find(line => line.includes('sleep'))?.trim().split(/\s+/)[0]
      expect(pid).toBeTruthy()
      expect((await run(`kill -0 ${pid}`)).code).toBe(0)
      expect((await run(`kill -s 0 ${pid}`)).code).toBe(0)
      expect((await run('kill -0 999999')).code).not.toBe(0)
      expect((await run('/bin/ps -e')).out).toContain('sleep')
      await run(`kill -9 ${pid}`)
    }, 30000)
  })
})
