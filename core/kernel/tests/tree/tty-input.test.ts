import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Real TTY input for worker programs: `Terminal.attachInput` routes `onData` into the `@zenfs/linux`
 * line discipline while a foreground process runs, so a program reading fd 0 gets canonical/raw
 * input and `^C`/`^Z` become signals via `ISIG` -- the same thing Linux does. Keystrokes here are
 * injected the way a real user's arrive: through xterm's `input()`, which fires `onData`.
 */
describe('TTY line discipline input for foreground worker programs', () => {
  let kernel: Kernel

  const type = (data: string) => kernel.terminal.input(data, true)
  const foregroundReady = () => waitFor(() => kernel.shell.foregroundJob?.processes.length === 1 && kernel.terminal.ttyInputAttached)

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

    // jsdom defines `ontouchstart`, so `Terminal._detectMobileSupport` calls this a mobile device --
    // which keeps the old `keyHandler` path (on-screen keyboards synthesize `keyHandler` calls, not
    // `onData`). These tests are about the desktop path, so pin it.
    ;(kernel.terminal as unknown as { _isMobile: boolean })._isMobile = false
  })

  it('a cooked-mode read returns the typed line (CR mapped to NL) and the line editor stays out of it', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tty-line.js', `
      const { read, writeAll } = globalThis.ecmaosSyscalls
      const buffer = new Uint8Array(64)
      const n = read(0, buffer, -1)
      writeAll(1, new TextEncoder().encode('got:' + new TextDecoder().decode(buffer.subarray(0, n))))
    `, { mode: 0o755 })

    const done = kernel.shell.execute('/tmp/tty-line.js > /tmp/tty-line.out')
    await foregroundReady()
    type('abc\r')
    expect(await done).toBe(0)

    expect(await kernel.filesystem.fs.readFile('/tmp/tty-line.out', 'utf8')).toBe('got:abc\n')
    expect(kernel.terminal.ttyInputAttached).toBe(false)
    expect(kernel.terminal.cmd).toBe('')
  })

  it('^C is raised by the line discipline (ISIG) and the program exits 130', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tty-int.js', 'await new Promise(r => setTimeout(r, 5000))', { mode: 0o755 })

    const done = kernel.shell.execute('/tmp/tty-int.js')
    await foregroundReady()
    type('\x03')

    expect(await done).toBe(130)
    expect(kernel.terminal.ttyInputAttached).toBe(false)
  })

  it('raw mode delivers single bytes, escape sequences whole, and ^C as data once ISIG is cleared', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tty-raw.js', `
      const { read, writeAll, tcgetattr, tcsetattr } = globalThis.ecmaosSyscalls
      const saved = tcgetattr(0)
      // ICANON = 0o2, ECHO = 0o10, ISIG = 0o1
      tcsetattr(0, { lflag: saved.lflag & ~(0o2 | 0o10 | 0o1) })
      const out = []
      const buffer = new Uint8Array(16)
      while (true) {
        const n = read(0, buffer, -1)
        out.push(Array.from(buffer.subarray(0, n)).join(','))
        if (buffer[0] === 113) break // q
      }
      tcsetattr(0, { lflag: saved.lflag })
      writeAll(1, new TextEncoder().encode(out.join('|')))
    `, { mode: 0o755 })

    const done = kernel.shell.execute('/tmp/tty-raw.js > /tmp/tty-raw.out')
    await foregroundReady()
    const tty = kernel.terminal.zfsTty!
    const consumed = () => waitFor(() => tty.available === 0)
    await waitFor(() => (tty.termios.lflag & 0o2) === 0) // the program has switched to raw mode
    for (const keys of ['a', '\x03', '\x1b[A']) {
      type(keys)
      await consumed()
    }
    type('q')

    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/tty-raw.out', 'utf8')).toBe('97|3|27,91,65|113')
    // termios put back: cooked again for whatever runs next
    expect(kernel.terminal.zfsTty!.termios.lflag & 0o2).toBe(0o2)
  })

  it('a killed foreground program ends the ^C echo line so the next prompt starts on a fresh line', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tty-nl.js', 'await new Promise(r => setTimeout(r, 5000))', { mode: 0o755 })
    let written = ''
    const original = kernel.terminal.write.bind(kernel.terminal)
    kernel.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
      written += typeof data === 'string' ? data : new TextDecoder().decode(data)
      return original(data, callback)
    }) as typeof kernel.terminal.write
    try {
      const done = kernel.shell.execute('/tmp/tty-nl.js')
      await foregroundReady()
      type('\x03')
      await done
    } finally {
      kernel.terminal.write = original
    }
    expect(written).toContain('^C')
    expect(written).toMatch(/\^C\r?\n/)
  })

  it('SIGWINCH interrupts a blocking terminal read so a program can redraw, then reads on', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tty-winch.js', `
      const { read, writeAll, tcgetattr, tcsetattr, onSignal } = globalThis.ecmaosSyscalls
      const saved = tcgetattr(0)
      tcsetattr(0, { lflag: saved.lflag & ~(0o2 | 0o10) })
      let winches = 0
      onSignal(28, () => { winches++ })
      const buffer = new Uint8Array(8)
      const seen = []
      while (true) {
        try {
          const n = read(0, buffer, -1)
          seen.push('k' + buffer[0])
          if (buffer[0] === 113) break
        } catch (error) {
          if (error.code !== 'EINTR') throw error
          seen.push('w' + winches)
        }
      }
      writeAll(1, new TextEncoder().encode(seen.join(',')))
    `, { mode: 0o755 })

    const done = kernel.shell.execute('/tmp/tty-winch.js > /tmp/tty-winch.out')
    await foregroundReady()
    const tty = kernel.terminal.zfsTty!
    await waitFor(() => (tty.termios.lflag & 0o2) === 0)
    await new Promise(resolve => setTimeout(resolve, 100)) // the handler is registered right after raw mode
    tty.signal(28)
    await new Promise(resolve => setTimeout(resolve, 100))
    type('q')

    expect(await done).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/tty-winch.out', 'utf8')).toBe('w1,k113')
  })

  it('^Z stops the foreground job through the line discipline and hands the terminal back', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/tty-stop.js', 'await new Promise(r => setTimeout(r, 5000))', { mode: 0o755 })

    void kernel.shell.execute('/tmp/tty-stop.js')
    await foregroundReady()
    const job = kernel.shell.foregroundJob!
    type('\x1a')

    await waitFor(() => job.status === 'stopped')
    expect(kernel.terminal.ttyInputAttached).toBe(false)

    job.processes[0]!.kill(9)
  })

  describe('less (real execve program on the raw TTY)', () => {
    const lflag = () => kernel.terminal.zfsTty!.termios.lflag
    let screen = ''
    let restoreWrite: () => void

    const captureScreen = () => {
      screen = ''
      const original = kernel.terminal.write.bind(kernel.terminal)
      kernel.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        screen += typeof data === 'string' ? data : new TextDecoder().decode(data)
        return original(data, callback)
      }) as typeof kernel.terminal.write
      restoreWrite = () => { kernel.terminal.write = original }
    }
    const rawReached = () => waitFor(() => (lflag() & 0o2) === 0)
    const numbered = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')

    it('pages a file: first screen, scrolls on ArrowDown/space, quits on q with the terminal restored', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/less-a.txt', numbered)
      captureScreen()
      try {
        const done = kernel.shell.execute('less /tmp/less-a.txt')
        await foregroundReady()
        await rawReached()
        await waitFor(() => screen.includes('line 1') && screen.includes('/ 200'))
        expect(screen).toContain('-- 1-')

        screen = ''
        type('\x1b[B') // ArrowDown
        await waitFor(() => screen.includes('-- 2-'))

        screen = ''
        type(' ') // page down
        await waitFor(() => /-- \d{2,3}-/.test(screen))

        type('q')
        expect(await done).toBe(0)
      } finally {
        restoreWrite()
      }
      expect(lflag() & 0o2).toBe(0o2) // canonical again
      expect(lflag() & 0o10).toBe(0o10) // echo again
      expect(kernel.terminal.ttyInputAttached).toBe(false)
    })

    it('takes its data from a pipe and its keys from the terminal (cat file | less)', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/less-b.txt', numbered)
      captureScreen()
      try {
        const done = kernel.shell.execute('cat /tmp/less-b.txt | less')
        await foregroundReady()
        await rawReached()
        await waitFor(() => screen.includes('line 1') && screen.includes('/ 200'))
        type('q')
        expect(await done).toBe(0)
      } finally {
        restoreWrite()
      }
      expect(lflag() & 0o2).toBe(0o2)
    })

    it('a pipeline stage finishing does not cook the terminal under a later stage still in raw mode', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/less-e.txt', numbered)
      const done = kernel.shell.execute('cat /tmp/less-e.txt | less')
      await foregroundReady()
      await rawReached()
      // cat has long since exited; less must still be in raw mode, still reading keys
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(lflag() & 0o2).toBe(0)
      expect(kernel.terminal.ttyInputAttached).toBe(true)
      type('q')
      expect(await done).toBe(0)
      expect(lflag() & 0o2).toBe(0o2)
    })

    it('prints instead of paging when stdout is not a terminal (less f > out, less | grep)', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/less-g.txt', 'alpha\nbeta\n')
      expect(await kernel.shell.execute('less /tmp/less-g.txt > /tmp/less-g.out')).toBe(0)
      expect(await kernel.filesystem.fs.readFile('/tmp/less-g.out', 'utf8')).toBe('alpha\nbeta\n')
      expect(await kernel.shell.execute('less /tmp/less-g.txt | grep beta > /tmp/less-g2.out')).toBe(0)
      expect(await kernel.filesystem.fs.readFile('/tmp/less-g2.out', 'utf8')).toBe('beta\n')
    })

    it('redraws when the window is resized (SIGWINCH) without waiting for a key', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/less-f.txt', numbered)
      captureScreen()
      try {
        const done = kernel.shell.execute('less /tmp/less-f.txt')
        await foregroundReady()
        await rawReached()
        await waitFor(() => screen.includes('/ 200'))
        await new Promise(resolve => setTimeout(resolve, 100)) // handler registered after the first frame
        screen = ''
        kernel.terminal.zfsTty!.signal(28)
        await waitFor(() => screen.includes('/ 200'))
        type('q')
        expect(await done).toBe(0)
      } finally {
        restoreWrite()
      }
    })

    it('a less killed with ^C mid-session cannot leave the terminal raw', async () => {
      await kernel.filesystem.fs.writeFile('/tmp/less-c.txt', numbered)
      const done = kernel.shell.execute('less /tmp/less-c.txt')
      await foregroundReady()
      await rawReached()
      type('\x03')
      expect(await done).toBe(130)
      expect(lflag() & 0o2).toBe(0o2)
      expect(lflag() & 0o10).toBe(0o10)
    })
  })

  describe('man (real execve program, shared pager)', () => {
    const run = async (command: string) => {
      const code = await kernel.shell.execute(`${command} > /tmp/man.out 2> /tmp/man.err`)
      return {
        code,
        out: await kernel.filesystem.fs.readFile('/tmp/man.out', 'utf8'),
        err: await kernel.filesystem.fs.readFile('/tmp/man.err', 'utf8')
      }
    }

    beforeAll(async () => {
      const fs = kernel.filesystem.fs
      await fs.mkdir('/tmp/docs/@acme/widget/guide', { recursive: true })
      await fs.writeFile('/tmp/docs/@acme/widget/index.md', '# Widget\n\nUse `widget` with **care**.\n')
      await fs.writeFile('/tmp/docs/@acme/widget/faq.txt', 'plain faq text\n')
      await fs.writeFile('/tmp/docs/@acme/widget/guide/index.html', '<h1>Guide</h1><p>Hello &amp; welcome</p>')
      await fs.mkdir('/tmp/docs/bare', { recursive: true })
      await fs.writeFile('/tmp/docs/bare/notes.md', 'notes\n')
    })

    it('prints the converted document when stdout is not a terminal (no paging, no hang)', async () => {
      const { code, out } = await run('man --where /tmp/docs @acme/widget')
      expect(code).toBe(0)
      expect(out).toContain('Widget')
      expect(out).toContain('\x1b[') // markdown became ANSI text
      expect(out).not.toContain('**')
      expect(out).not.toContain('`')
    })

    it('finds a topic file and converts html', async () => {
      expect((await run('man --where /tmp/docs @acme/widget/faq')).out).toBe('plain faq text\n\n')
      expect((await run('man --where /tmp/docs @acme/widget/guide')).out).toContain('Hello & welcome')
    })

    it('lists topics with -l and reports a package with no index', async () => {
      expect((await run('man -l --where /tmp/docs @acme/widget')).out).toBe('@acme/widget:\n  faq\n  guide\n')
      const noIndex = await run('man --where /tmp/docs bare')
      expect(noIndex.code).toBe(0)
      expect(noIndex.out).toContain('No index found, try a topic: man bare/notes')
      expect(noIndex.out).toContain('  notes')
    })

    it('honours MANPATH and fails cleanly for an unknown entry', async () => {
      const missing = await run('man --where /tmp/docs nosuchpkg')
      expect(missing.code).toBe(1)
      expect(missing.err).toBe('man: no manual entry for nosuchpkg\n')
      expect((await run('man --where')).err).toBe('man: missing argument to --where\n')
    })

    it('pages on the terminal: scrolls with the keys, quits with q, terminal restored', async () => {
      const long = Array.from({ length: 150 }, (_, i) => `manline ${i + 1}`).join('\n')
      await kernel.filesystem.fs.writeFile('/tmp/docs/bare/long.txt', long)
      let screen = ''
      const original = kernel.terminal.write.bind(kernel.terminal)
      kernel.terminal.write = ((data: string | Uint8Array, callback?: () => void) => {
        screen += typeof data === 'string' ? data : new TextDecoder().decode(data)
        return original(data, callback)
      }) as typeof kernel.terminal.write
      try {
        const done = kernel.shell.execute('man --where /tmp/docs bare/long')
        await foregroundReady()
        await waitFor(() => (kernel.terminal.zfsTty!.termios.lflag & 0o2) === 0)
        await waitFor(() => screen.includes('manline 1') && screen.includes('-- bare/long 1-'))
        screen = ''
        type(' ')
        await waitFor(() => /-- bare\/long \d{2,3}-/.test(screen))
        type('q')
        expect(await done).toBe(0)
      } finally {
        kernel.terminal.write = original
      }
      expect(kernel.terminal.zfsTty!.termios.lflag & 0o2).toBe(0o2)
    })
  })
})
