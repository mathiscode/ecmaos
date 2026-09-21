import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * Presenters: worker-hosted DOM commands ask the kernel to put something on screen through
 * `window_present` (`#lib/presenters/index.ts`). These tests stub the browser APIs a presenter
 * ends in (`window.open`, downloads) and assert on what the *program* made the kernel do.
 */
/**
 * A stand-in for vim.wasm: it records how it was started, and a test drives its callbacks the way
 * the real editor would (init, a save, an exit).
 */
const fakeVim = vi.hoisted(() => ({
  instances: [] as Array<{
    startOptions?: Record<string, unknown>
    onFileExport?: (path: string, contents: ArrayBuffer) => Promise<void>
    onVimExit?: (status: number) => void
    onVimInit?: () => Promise<void>
    onError?: (error: Error) => Promise<void>
  }>,
  compatibilityError: undefined as string | undefined
}))

vi.mock('vim-wasm/vimwasm.js', () => ({
  checkBrowserCompatibility: () => fakeVim.compatibilityError,
  VimWasm: class {
    startOptions?: Record<string, unknown>
    constructor() { fakeVim.instances.push(this) }
    start(options: Record<string, unknown>) { this.startOptions = options }
    isRunning() { return true }
    resize() {}
    async cmdline() {}
  }
}))

describe('open: a real execve program driving the external and download presenters', () => {
  let kernel: Kernel
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} 2> /tmp/open.err`)
    return { code, err: await kernel.filesystem.fs.readFile('/tmp/open.err', 'utf8') }
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

  afterEach(() => vi.restoreAllMocks())

  it('opens a URL in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect((await run('open https://example.com/a?b=c')).code).toBe(0)
    expect(open).toHaveBeenCalledWith('https://example.com/a?b=c', '_blank')
  })

  it('downloads a file, resolving it against the working directory and keeping its bytes', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/dl', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/dl/report.bin', new Uint8Array([1, 2, 3, 250]))

    let blob: Blob | undefined
    Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: (b: Blob) => { blob = b; return 'blob:test' } })
    Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: () => {} })
    let downloadName: string | undefined
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download })

    expect((await run('cd /tmp/dl; open ./report.bin')).code).toBe(0)
    expect(downloadName).toBe('report.bin')
    // jsdom's Blob has no `arrayBuffer()`; FileReader is what it does implement
    const bytes = await new Promise<ArrayBuffer>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(blob!)
    })
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 250]))
  })

  it('reports usage errors and a missing file', async () => {
    expect(await run('open')).toEqual({ code: 1, err: "open: missing file or URL argument\nTry 'open --help' for more information.\n" })
    const missing = await run('open /tmp/dl/nope.txt')
    expect(missing).toEqual({ code: 1, err: 'open: file not found: /tmp/dl/nope.txt\n' })
    expect((await run('open --help')).err).toContain('Usage: open [FILE|URL]')
  })

  it('rejects an unknown presenter kind rather than evaluating it', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/present-bad.js', `
      const { custom, open, read, close, writeAll, unlink } = globalThis.ecmaosSyscalls
      const path = '/tmp/.present-bad-result'
      await custom('window_present', 'constructor', '{}', path)
      const fd = open(path, 0)
      const buffer = new Uint8Array(256)
      const n = read(fd, buffer, -1)
      close(fd)
      unlink(path)
      writeAll(1, buffer.subarray(0, n))
    `, { mode: 0o755 })
    await kernel.shell.execute('/tmp/present-bad.js > /tmp/present-bad.out')
    expect(JSON.parse(await kernel.filesystem.fs.readFile('/tmp/present-bad.out', 'utf8'))).toEqual({ error: 'unknown presenter: constructor' })
  })

  describe('video and play: media presenters', () => {
    let created: Array<Record<string, unknown>>
    let played: number

    /**
     * jsdom decodes nothing, so a media element never reports metadata. Standing in for the browser:
     * setting `src` finishes loading on the next microtask (or errors, for the 99-byte file), with
     * a fixed size and duration.
     */
    const stubMedia = () => {
      created = []
      played = 0
      Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: (b: Blob) => `blob:test-${b.type}-${b.size}` })
      Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: () => {} })
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        get(this: HTMLMediaElement) { return this.getAttribute('src') ?? '' },
        set(this: HTMLMediaElement, value: string) {
          this.setAttribute('src', value)
          queueMicrotask(() => (value.endsWith('-99') ? this.onerror?.(new Event('error')) : this.onloadedmetadata?.(new Event('loadedmetadata'))))
        }
      })
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 65 })
      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1600 })
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 900 })
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => { played++; return Promise.resolve() })
      vi.spyOn(kernel.windows, 'create').mockImplementation(((options: Record<string, unknown>) => { created.push(options); return {} }) as never)
    }
    const output = async (command: string) => {
      const code = await kernel.shell.execute(`${command} > /tmp/media.out 2> /tmp/media.err`)
      return { code, out: await kernel.filesystem.fs.readFile('/tmp/media.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/media.err', 'utf8') }
    }

    beforeAll(async () => {
      await kernel.filesystem.fs.mkdir('/tmp/media', { recursive: true })
      for (const name of ['clip.mp4', 'song.mp3']) await kernel.filesystem.fs.writeFile(`/tmp/media/${name}`, new Uint8Array([0, 1, 2]))
      await kernel.filesystem.fs.writeFile('/tmp/media/bad.mp4', new Uint8Array(99))
    })

    it('video: sizes the window to the requested width by the video ratio and reports the duration', async () => {
      stubMedia()
      const { code, out } = await output('cd /tmp/media; video --loop --width 800 --no-controls clip.mp4')
      expect(code).toBe(0)
      expect(out).toBe('Loading video: clip.mp4...\nPlaying: clip.mp4 (1:05)\n')
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({ title: 'clip.mp4', width: 800, height: 450, max: false })
      const html = created[0]!['html'] as string
      expect(html).toContain('src="blob:test-video/mp4-3"')
      expect(html).toContain('autoplay')
      expect(html).toContain('loop')
      expect(html).not.toContain('controls')
    })

    it('video: falls back to a default size when metadata cannot load, and skips a missing file', async () => {
      stubMedia()
      const { code, err } = await output('cd /tmp/media; video bad.mp4 nope.mp4')
      expect(code).toBe(0)
      expect(err).toContain('video: warning: could not load metadata for bad.mp4, using default size')
      expect(err).toContain('video: file not found: /tmp/media/nope.mp4')
      expect(created[0]).toMatchObject({ width: 640, height: 360 })
    })

    it('video: rejects bad options and a missing file argument', async () => {
      stubMedia()
      expect((await output('video --width abc x.mp4')).err).toBe('video: invalid width: abc\n')
      expect((await output('video')).err).toBe("video: missing file argument\nTry 'video --help' for more information.\n")
      expect(created).toHaveLength(0)
    })

    it('video: numbers the windows of several files', async () => {
      stubMedia()
      await output('cd /tmp/media; video clip.mp4 bad.mp4')
      expect(created.map(w => w['title'])).toEqual(['clip.mp4 (1/2)', 'bad.mp4 (2/2)'])
    })

    it('play: opens a player window at the given volume', async () => {
      stubMedia()
      const { code, out } = await output('cd /tmp/media; play --volume 50 --loop song.mp3')
      expect(code).toBe(0)
      expect(out).toBe('Loading audio: song.mp3...\nPlaying: song.mp3 (1:05)\n')
      expect(created[0]).toMatchObject({ title: 'song.mp3', width: 500, height: 200 })
      const html = created[0]!['html'] as string
      expect(html).toContain('src="blob:test-audio/mpeg-3"')
      expect(html).toContain('audio.volume = 0.5')
      expect(html).toContain('loop')
    })

    it('play --quiet plays in the background with no window', async () => {
      stubMedia()
      const { out } = await output('cd /tmp/media; play --quiet song.mp3')
      expect(out).toBe('Loading audio: song.mp3...\nPlaying in background: song.mp3 (1:05)\n')
      expect(created).toHaveLength(0)
      expect(played).toBe(1)
    })

    it('play: validates volume and escapes a file name that is markup', async () => {
      stubMedia()
      expect((await output('play --volume 150 song.mp3')).err).toBe('play: invalid volume: 150 (must be 0-100)\n')
      await kernel.filesystem.fs.writeFile('/tmp/media/<b>x.mp3', new Uint8Array([0]))
      await output('cd /tmp/media; play "<b>x.mp3"')
      expect(created[0]!['html'] as string).toContain('&lt;b&gt;x.mp3')
    })

    describe('view: the document presenter', () => {
      const mounted: HTMLElement[] = []
      const stubView = () => {
        stubMedia()
        mounted.length = 0
        ;(kernel.windows.create as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation((options: Record<string, unknown>) => {
          created.push(options)
          return { mount: (el: HTMLElement) => { mounted.push(el) }, setTitle: () => {}, body: document.createElement('div') }
        })
      }

      beforeAll(async () => {
        const fs = kernel.filesystem.fs
        await fs.writeFile('/tmp/media/doc.md', '# Title\n\nsome *text*\n')
        await fs.writeFile('/tmp/media/data.json', '{"a":[1,2,3]}')
        await fs.writeFile('/tmp/media/broken.json', '{nope')
        await fs.writeFile('/tmp/media/pic.png', new Uint8Array([137, 80, 78, 71]))
        await fs.writeFile('/tmp/media/blob.xyz', new Uint8Array([1, 2]))
      })

      it('renders markdown into a 900x700 window', async () => {
        stubView()
        const { code, err } = await output('cd /tmp/media; view doc.md')
        expect(err).toBe('')
        expect(code).toBe(0)
        expect(created[0]).toMatchObject({ title: 'doc.md', width: 900, height: 700 })
        expect(mounted[0]!.querySelector('h1')!.textContent).toBe('Title')
        expect(mounted[0]!.querySelector('em')!.textContent).toBe('text')
      })

      it('reports "Viewing" for a JSON file and an invalid-JSON error without failing the command', async () => {
        stubView()
        const good = await output('cd /tmp/media; view data.json')
        expect(good.out).toBe('Viewing: data.json\n')
        expect(created).toHaveLength(1)

        const bad = await output('cd /tmp/media; view broken.json')
        expect(bad.code).toBe(0)
        expect(bad.err).toMatch(/^view: invalid JSON in broken\.json: /)
        expect(created).toHaveLength(1) // no window for the broken one
      })

      it('views an image and plays a video with the duration line', async () => {
        stubView()
        expect((await output('cd /tmp/media; view pic.png')).out).toBe('Viewing: pic.png\n')
        expect(created).toHaveLength(1)
        const video = await output('cd /tmp/media; view clip.mp4')
        expect(video.out).toBe('Playing: clip.mp4 (1:05)\n')
        expect(created).toHaveLength(2)
      })

      it('plays audio quietly with no window and reports it', async () => {
        stubView()
        const { out } = await output('cd /tmp/media; view --quiet song.mp3')
        expect(out).toBe('Playing in background: song.mp3 (1:05)\n')
        expect(created).toHaveLength(0)
        expect(played).toBe(1)
      })

      it('warns when metadata cannot load, skips missing files, and validates options', async () => {
        stubView()
        const { err } = await output('cd /tmp/media; view bad.mp4 nope.png')
        expect(err).toContain('view: warning: could not load metadata for bad.mp4, using default size')
        expect(err).toContain('view: file not found: /tmp/media/nope.png')
        expect((await output('view --volume 999 x')).err).toBe('view: invalid volume: 999 (must be 0-100)\n')
        expect((await output('view')).err).toBe("view: missing file argument\nTry 'view --help' for more information.\n")
      })
    })
  })

  describe('web: the browser presenter', () => {
    let windows: Array<{ options: Record<string, unknown>, mounted?: HTMLElement }>
    const stubWindows = () => {
      windows = []
      vi.spyOn(kernel.windows, 'create').mockImplementation(((options: Record<string, unknown>) => {
        const entry: { options: Record<string, unknown>, mounted?: HTMLElement } = { options }
        windows.push(entry)
        return { mount: (el: HTMLElement) => { entry.mounted = el }, setTitle: () => {} }
      }) as never)
    }
    const run = async (command: string) => {
      const code = await kernel.shell.execute(`${command} 2> /tmp/web.err`)
      return { code, err: await kernel.filesystem.fs.readFile('/tmp/web.err', 'utf8') }
    }

    it('opens a contained window with a navbar and an iframe on the (normalized) URL', async () => {
      stubWindows()
      expect((await run('web example.com/page')).code).toBe(0)
      expect(windows).toHaveLength(1)
      expect(windows[0]!.options['title']).toBe('https://example.com/page')
      const el = windows[0]!.mounted!
      expect(el.querySelector('iframe')!.getAttribute('src')).toBe('https://example.com/page')
      expect(el.querySelectorAll('button').length).toBe(3) // back, forward, refresh
      expect(el.querySelector('input')).not.toBeNull()
    })

    it('--no-navbar (also glued to the URL) leaves just the iframe', async () => {
      stubWindows()
      await run('web --no-navbar http://localhost:8080/')
      expect(windows[0]!.mounted!.querySelectorAll('button').length).toBe(0)
      expect(windows[0]!.mounted!.querySelector('iframe')!.getAttribute('src')).toBe('http://localhost:8080/')
    })

    it('validates its arguments', async () => {
      stubWindows()
      expect(await run('web')).toEqual({ code: 1, err: "web: missing URL argument\nTry 'web --help' for more information.\n" })
      expect(await run('web http://')).toEqual({ code: 1, err: 'web: invalid URL: http://\n' })
      expect((await run('web --help')).err).toContain('Usage: web [OPTIONS] [URL]')
      expect(windows).toHaveLength(0)
    })
  })

  describe('vim: the editor presenter holds the program until the editor exits', () => {
    let windows: Array<{ options: Record<string, unknown>, closed: boolean }>
    const stubWindows = () => {
      windows = []
      fakeVim.instances.length = 0
      fakeVim.compatibilityError = undefined
      vi.spyOn(kernel.windows, 'create').mockImplementation(((options: Record<string, unknown>) => {
        const entry = { options, closed: false }
        windows.push(entry)
        return { mount: () => {}, setTitle: () => {}, close: () => { entry.closed = true } }
      }) as never)
    }
    const started = async () => {
      const start = Date.now()
      while (!fakeVim.instances[0]?.startOptions) {
        if (Date.now() - start > 3000) throw new Error('vim never started')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return fakeVim.instances[0]
    }
    const run = (command: string) => kernel.shell.execute(`${command} 2> /tmp/vim.err`)
    const stderr = () => kernel.filesystem.fs.readFile('/tmp/vim.err', 'utf8')

    it('opens a 900x700 window with the file, its directory tree, and returns vim\'s exit status', async () => {
      stubWindows()
      await kernel.filesystem.fs.mkdir('/tmp/vimtest/deep', { recursive: true })
      await kernel.filesystem.fs.writeFile('/tmp/vimtest/deep/a.txt', 'alpha\n')

      const done = run('cd /tmp/vimtest; vim deep/a.txt new.txt')
      const vim = await started()

      expect(windows[0]!.options).toMatchObject({ title: 'a.txt', width: 900, height: 700 })
      expect(vim.startOptions).toMatchObject({
        files: { '/tmp/vimtest/deep/a.txt': 'alpha\n', '/tmp/vimtest/new.txt': '' },
        cmdArgs: ['/tmp/vimtest/deep/a.txt', '/tmp/vimtest/new.txt'],
        debug: false
      })
      // vim.wasm's own default dirs are left out; parents come before children
      const dirs = vim.startOptions!['dirs'] as string[]
      expect(dirs).toEqual(expect.arrayContaining(['/tmp/vimtest', '/tmp/vimtest/deep']))
      expect(dirs).not.toContain('/tmp')
      expect(dirs.indexOf('/tmp/vimtest')).toBeLessThan(dirs.indexOf('/tmp/vimtest/deep'))

      // it is still running: the command has not returned
      expect(await Promise.race([done, new Promise(resolve => setTimeout(() => resolve('still running'), 300))])).toBe('still running')

      vim.onVimExit!(0)
      expect(await done).toBe(0)
      expect(windows[0]!.closed).toBe(true)
    })

    it('returns 1 when vim exits non-zero', async () => {
      stubWindows()
      const done = run('vim /tmp/vimtest/x.txt')
      const vim = await started()
      vim.onVimExit!(1)
      expect(await done).toBe(1)
    })

    it('saves through the user\'s filesystem when vim exports a buffer', async () => {
      stubWindows()
      const done = run('vim /tmp/vimtest/saved.txt')
      const vim = await started()
      await vim.onFileExport!('/tmp/vimtest/saved.txt', new TextEncoder().encode('written by vim\n').buffer as ArrayBuffer)
      vim.onVimExit!(0)
      await done
      expect(await kernel.filesystem.fs.readFile('/tmp/vimtest/saved.txt', 'utf8')).toBe('written by vim\n')
    })

    it('reports an editor error on stderr and exits 1', async () => {
      stubWindows()
      const done = run('vim /tmp/vimtest/err.txt')
      const vim = await started()
      await vim.onError!(new Error('wasm exploded'))
      expect(await done).toBe(1)
      expect(await stderr()).toBe('vim: error: wasm exploded\n')
      expect(windows[0]!.closed).toBe(true)
    })

    it('the user closing the window ends the session instead of hanging', async () => {
      stubWindows()
      const done = run('vim /tmp/vimtest/close.txt')
      await started()
      ;(windows[0]!.options['onclose'] as () => boolean)()
      expect(await done).toBe(1)
    })

    it('killing the process closes the window with it', async () => {
      stubWindows()
      const done = run('vim /tmp/vimtest/kill.txt')
      await started()
      kernel.shell.foregroundJob!.processes[0]!.kill(2)
      expect(await done).toBe(130)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(windows[0]!.closed).toBe(true)
    })

    it('reports usage errors, a directory argument, and an incompatible browser', async () => {
      stubWindows()
      expect(await run('vim')).toBe(1)
      expect(await stderr()).toBe("vim: no file specified\nTry 'vim --help' for more information.\n")
      expect(await run('vim /tmp/vimtest')).toBe(1)
      expect(await stderr()).toBe('vim: /tmp/vimtest: Is a directory\n')

      fakeVim.compatibilityError = 'SharedArrayBuffer is not supported'
      expect(await run('vim /tmp/vimtest/x.txt')).toBe(1)
      expect(await stderr()).toBe('vim: SharedArrayBuffer is not supported\n')
      expect(windows).toHaveLength(0)
    })
  })
})
