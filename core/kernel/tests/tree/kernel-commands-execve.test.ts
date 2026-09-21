import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `download`, `load`, `passwd`, `screensaver`, `snake`, `upload` and `install`: the last of the
 * kernel's own commands to leave the legacy in-process shim. Each is now a real worker-hosted
 * program; the parts that need the DOM or kernel singletons run main-thread side (the `download`,
 * `script` and `upload` presenters, `screensaver_run`, `users_password`).
 */
describe('the kernel-native commands as execve programs', () => {
  let kernel: Kernel
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/kc.out 2> /tmp/kc.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/kc.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/kc.err', 'utf8')
    }
  }

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('are real programs under /bin, not legacy stubs', async () => {
    for (const name of ['download', 'load', 'passwd', 'screensaver', 'snake', 'upload', 'install']) {
      const source = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf8')
      expect(source.startsWith('#!ecmaos:bin:command:'), name).toBe(false)
    }
  })

  it('print usage for --help', async () => {
    for (const name of ['download', 'load', 'passwd', 'screensaver', 'snake', 'upload', 'install']) {
      const { code, err } = await run(`${name} --help`)
      expect(code, name).toBe(0)
      expect(err, name).toContain(`Usage: ${name}`)
    }
  })

  describe('download', () => {
    it('needs a file operand and reports a missing file', async () => {
      expect((await run('download')).code).toBe(1)
      const missing = await run('download /tmp/nope.bin')
      expect(missing.code).toBe(1)
      expect(missing.err).toContain('/tmp/nope.bin not found')
    })

    it('hands the file to the browser as a blob download named after it', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/dl.txt', 'payload')
      const blobs: Blob[] = []
      ;(window.URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = blob => { blobs.push(blob); return 'blob:test' }
      ;(window.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
      const clicked: string[] = []
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download) })

      const { code } = await run('download /tmp/dl.txt')
      expect(code).toBe(0)
      expect(blobs).toHaveLength(1)
      expect(blobs[0]!.size).toBe('payload'.length)
      expect(clicked).toEqual(['dl.txt'])
    })
  })

  describe('load', () => {
    it('needs an operand', async () => {
      expect((await run('load')).code).toBe(1)
    })

    it('runs the file in the page global scope, relative to the cwd', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/load-ok.js', 'globalThis.__loaded = 42')
      await kernel.shell.execute('cd /tmp')
      const { code } = await run('load load-ok.js')
      await kernel.shell.execute('cd /')
      expect(code).toBe(0)
      expect((globalThis as Record<string, unknown>)['__loaded']).toBe(42)
    })

    it('reports a script that throws and a file that is missing', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/load-bad.js', 'throw new Error("boom")')
      const bad = await run('load /tmp/load-bad.js')
      expect(bad.code).toBe(1)
      expect(bad.err).toContain('load: boom')
      expect((await run('load /tmp/none.js')).code).toBe(1)
    })
  })

  describe('screensaver', () => {
    it('rejects an unknown screensaver', async () => {
      const { code, err } = await run('screensaver nonesuch')
      expect(code).toBe(1)
      expect(err).toContain('Invalid screensaver')
    })

    it('starts a registered one and saves it with --set; off clears it', async () => {
      const started = vi.fn()
      kernel.screensavers.set('kc-test', { default: started } as never)

      expect((await run('screensaver kc-test --set')).code).toBe(0)
      expect(started).toHaveBeenCalledOnce()
      expect(kernel.storage.local.getItem('screensaver')).toBe('kc-test')

      expect((await run('screensaver')).code).toBe(0)
      expect(started).toHaveBeenCalledTimes(2)

      expect((await run('screensaver off')).code).toBe(0)
      expect(kernel.storage.local.getItem('screensaver')).toBeNull()
    })
  })

  describe('passwd', () => {
    it('rejects a wrong current password', async () => {
      const { code, err } = await run('passwd wrong-password new-password')
      expect(code).toBe(1)
      expect(err).toContain('Failed to update password')
    })

    it('changes the password with OLD NEW arguments, and back', async () => {
      const changed = await run('passwd root hunter2')
      expect(changed.code).toBe(0)
      expect(changed.out).toContain('Password updated successfully')

      // the old password no longer verifies; the new one does
      expect((await run('passwd root again')).code).toBe(1)
      expect((await run('passwd hunter2 root')).code).toBe(0)
    })
  })

  describe('snake', () => {
    it('refuses to run without a terminal', async () => {
      // every fd a file: stdin from a real (empty) file, stdout and stderr redirected by `run`
      await kernel.filesystem.fs.writeFile('/tmp/kc.empty', '')
      const { code, err } = await run('snake < /tmp/kc.empty')
      expect(code).toBe(1)
      expect(err).toContain('snake: not a terminal')
    })
  })

  describe('upload', () => {
    const pick = (files: Array<{ name: string, data: string }> | 'cancel') => {
      vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
        setTimeout(() => {
          if (files === 'cancel') return void this.dispatchEvent(new Event('cancel'))
          const list = files.map(file => ({ name: file.name, arrayBuffer: async () => new TextEncoder().encode(file.data).buffer }))
          Object.defineProperty(this, 'files', { value: list, configurable: true })
          this.dispatchEvent(new Event('change'))
        }, 0)
      })
    }

    it('writes the chosen files into the directory and lists them', async () => {
      await kernel.filesystem.fs.mkdir('/tmp/up', { recursive: true })
      pick([{ name: 'a.txt', data: 'aaa' }, { name: 'b.txt', data: 'bb' }])

      const { code, out } = await run('upload /tmp/up')
      expect(code).toBe(0)
      expect(out.split('\n').filter(Boolean)).toEqual(['a.txt', 'b.txt'])
      expect(await kernel.filesystem.fs.readFile('/tmp/up/a.txt', 'utf8')).toBe('aaa')
      expect(await kernel.filesystem.fs.readFile('/tmp/up/b.txt', 'utf8')).toBe('bb')
    })

    it('finishes cleanly when the dialog is cancelled', async () => {
      pick('cancel')
      const { code, out } = await run('upload /tmp/up')
      expect(code).toBe(0)
      expect(out).toBe('')
    })

    it('reports a file it cannot write and exits 1', async () => {
      pick([{ name: 'x.txt', data: 'x' }])
      const { code, err } = await run('upload /tmp/no-such-dir/deeper')
      expect(code).toBe(1)
      expect(err).toContain('Failed to upload x.txt')
    })
  })

  describe('install', () => {
    it('needs a package', async () => {
      const { code, err } = await run('install')
      expect(code).toBe(1)
      expect(err).toContain('Usage: install')
    })

    it('reports an unreachable registry instead of crashing', async () => {
      const { code, err } = await run('install left-pad --registry http://127.0.0.1:1')
      expect(code).toBe(1)
      expect(err).toContain('install:')
    })
  })
})
