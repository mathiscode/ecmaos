import { beforeAll, describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `#!ecmaos:bin:program:<name>` files are `@ecmaos-apps/*` programs run by `/bin/app` as real worker
 * processes. `params` is rebuilt over syscalls (stdio fds, tty, fs, a few kernel capabilities), so
 * these tests drive a fixture app through the shell and assert on what that surface does.
 */
async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('app runner: worker-hosted @ecmaos-apps programs', () => {
  let kernel: Kernel
  const type = (data: string) => kernel.terminal.input(data, true)
  const foregroundReady = () => waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)

  const install = async (name: string, body: string) => {
    await kernel.filesystem.fs.writeFile(`/tmp/${name}`, `#!ecmaos:bin:program:${name}\n${body}\n`)
    await kernel.filesystem.fs.chmod(`/tmp/${name}`, 0o755)
  }
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/app.out 2> /tmp/app.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/app.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/app.err', 'utf8') }
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
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
  })

  it('/bin/app exists and a program header routes to it', async () => {
    expect(await kernel.filesystem.fs.exists('/bin/app')).toBe(true)
    await install('hello', `export default async ({ args, terminal, command }) => { terminal.writeln('hi ' + command + ' ' + args.join(',')) }`)
    const { code, out } = await run('/tmp/hello a b')
    expect(code).toBe(0)
    expect(out).toBe('hi hello a,b\r\n')
  })

  it("returns main's number as the exit code and 0 otherwise", async () => {
    await install('exit3', `export default async () => 3`)
    expect((await run('/tmp/exit3')).code).toBe(3)
  })

  it('reports a module with no main and an uncaught error', async () => {
    await install('nomain', `export const x = 1`)
    const missing = await run('/tmp/nomain')
    expect(missing.code).not.toBe(0)
    expect(missing.err).toContain('no main function found in module')

    await install('boom', `export default async () => { throw new Error('kaboom') }`)
    const boom = await run('/tmp/boom')
    expect(boom.code).toBe(1)
    expect(boom.err).toContain('kaboom')
  })

  it('gives stdout/stderr streams, env and real ids', async () => {
    await install('ids', `export default async ({ terminal, shell, uid, gid, pid, env, cwd }) => {
      const out = terminal.stdout.getWriter()
      await out.write(new TextEncoder().encode('OUT ' + uid + ' ' + gid + ' ' + (pid > 0) + ' ' + cwd + '\\n'))
      out.releaseLock()
      const err = terminal.stderr.getWriter()
      await err.write(new TextEncoder().encode('ERR ' + shell.envObject.FOO + ' ' + env.FOO + '\\n'))
    }`)
    kernel.shell.env.set('FOO', 'bar')
    const { out, err } = await run('/tmp/ids')
    expect(out).toBe('OUT 0 0 true /\n')
    expect(err).toBe('ERR bar bar\n')
  })

  it('reads stdin through a pipe', async () => {
    await install('upper', `export default async ({ stdin, terminal }) => {
      const reader = stdin.getReader()
      let text = ''
      while (true) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value) }
      terminal.write(text.toUpperCase())
    }`)
    expect((await run('echo shout | /tmp/upper')).out).toBe('SHOUT\n')
  })

  it('shell.context.fs.promises works over real syscalls', async () => {
    await install('files', `export default async ({ shell, terminal }) => {
      const fs = shell.context.fs.promises
      await fs.mkdir('/tmp/app-deep/a/b', { recursive: true })
      await fs.writeFile('/tmp/app-deep/a/b/f.txt', 'contents')
      terminal.writeln(String(await fs.exists('/tmp/app-deep/a/b/f.txt')) + ' ' + await fs.readFile('/tmp/app-deep/a/b/f.txt', 'utf-8') + ' ' + String(await fs.exists('/tmp/app-none')))
      await fs.unlink('/tmp/app-deep/a/b/f.txt')
      terminal.writeln(String(await fs.exists('/tmp/app-deep/a/b/f.txt')))
    }`)
    const { out } = await run('/tmp/files')
    expect(out).toBe('true contents false\r\nfalse\r\n')
    expect(await kernel.filesystem.fs.exists('/tmp/app-deep/a/b')).toBe(true)
  })

  it('exposes the kernel name/id and raises toasts', async () => {
    const success = vi.spyOn(kernel.dom.toast, 'success').mockReturnValue(undefined as never)
    await install('kern', `export default async ({ kernel, terminal }) => {
      terminal.writeln(kernel.name + ' ' + kernel.id)
      await kernel.dom.toast.success('loaded')
    }`)
    const { out } = await run('/tmp/kern')
    expect(out).toBe(`${kernel.name} ${kernel.id}\r\n`)
    expect(success).toHaveBeenCalledWith('loaded')
    success.mockRestore()
  })

  it('an app with no terminal reports zero-size defaults instead of crashing', async () => {
    await install('size', `export default async ({ terminal }) => { terminal.writeln(terminal.rows + 'x' + terminal.columns) }`)
    expect((await run('/tmp/size')).out).toMatch(/^\d+x\d+\r\n$/)
  })

  it('readline reads one edited line from the terminal', async () => {
    await install('ask', `export default async ({ terminal }) => {
      const name = await terminal.readline('name? ')
      terminal.writeln('hello ' + name)
    }`)
    const done = kernel.shell.execute('/tmp/ask > /tmp/ask.out')
    await foregroundReady()
    await new Promise(resolve => setTimeout(resolve, 200))
    type('Ada\r')
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/ask.out', 'utf8')).toBe('name? hello Ada\r\n')
  })

  it('onKey delivers single keys in raw mode, with ctrl and named keys decoded', async () => {
    await install('keys', `export default async ({ terminal }) => {
      const seen = []
      await new Promise(resolve => {
        terminal.onKey(({ domEvent }) => {
          seen.push(domEvent.ctrlKey ? 'C-' + domEvent.key : domEvent.key)
          if (seen.length === 4) resolve()
        })
      })
      terminal.writeln(seen.join(' '))
    }`)
    const done = kernel.shell.execute('/tmp/keys > /tmp/keys.out')
    await foregroundReady()
    await new Promise(resolve => setTimeout(resolve, 200))
    type('a')
    type('\x1b[A')
    type('\x0c')
    type('\r')
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/keys.out', 'utf8')).toBe('a ArrowUp C-l Enter\r\n')
    expect(kernel.terminal.ttyInputAttached).toBe(false)
  })

  it('keys typed ahead of a readline call become that line', async () => {
    await install('ahead', `export default async ({ terminal }) => {
      await new Promise(resolve => terminal.onKey(resolve))
      const line = await terminal.readline('> ')
      terminal.writeln('[' + line + ']')
    }`)
    const done = kernel.shell.execute('/tmp/ahead > /tmp/ahead.out')
    await foregroundReady()
    await new Promise(resolve => setTimeout(resolve, 200))
    type(':wq\r')
    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/ahead.out', 'utf8')).toContain('[wq]')
  })

  it('^C ends a running app with 130', async () => {
    await install('spin', `export default async () => { await new Promise(resolve => setTimeout(resolve, 5000)) }`)
    const done = kernel.shell.execute('/tmp/spin')
    await foregroundReady()
    type('\x03')
    expect(await done).toBe(130)
  })

  describe('the real @ecmaos-apps bundles', () => {
    // The built bundles (`pnpm build` in apps/*); a checkout that has not built them skips these
    const bundles = import.meta.glob('../../../../apps/*/dist/index.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const bundle = (name: string) => bundles[`../../../../apps/${name}/dist/index.js`]
    const built = (name: string) => bundle(name) !== undefined
    const installBundle = async (name: string) => {
      await kernel.filesystem.fs.writeFile(`/tmp/${name}`, bundle(name)!)
      await kernel.filesystem.fs.chmod(`/tmp/${name}`, 0o755)
    }

    it.runIf(built('boilerplate'))('boilerplate greets through terminal, kernel and a toast', async () => {
      await installBundle('boilerplate')
      const success = vi.spyOn(kernel.dom.toast, 'success').mockReturnValue(undefined as never)
      const { code, out } = await run('/tmp/boilerplate one two')
      success.mockRestore()
      expect(code).toBe(0)
      expect(out).toContain(`Hello, ${kernel.name} ${kernel.id}!`)
      expect(out).toContain('ARGS: one two')
    })

    it.runIf(built('ai'))('ai prints its help', async () => {
      await installBundle('ai')
      const { code, out, err } = await run('/tmp/ai --help')
      expect(`${out}${err}`).toContain('Usage: ai [options] [prompt]')
      expect(code).toBe(0)
    })

    it.runIf(built('edit'))('edit opens a file, inserts text and saves it with :wq', async () => {
      await installBundle('edit')
      await kernel.filesystem.fs.writeFile('/tmp/edit-me.txt', 'world\n')

      const done = kernel.shell.execute('/tmp/edit /tmp/edit-me.txt > /tmp/edit.out')
      await foregroundReady()
      await new Promise(resolve => setTimeout(resolve, 500))
      type('i')
      await new Promise(resolve => setTimeout(resolve, 100))
      type('hello ')
      await new Promise(resolve => setTimeout(resolve, 100))
      type('\x1b')
      await new Promise(resolve => setTimeout(resolve, 100))
      type(':')
      await new Promise(resolve => setTimeout(resolve, 300))
      type('wq\r')
      expect(await done).toBe(0)
      expect(await kernel.filesystem.fs.readFile('/tmp/edit-me.txt', 'utf8')).toContain('hello world')
    })
  })
})
