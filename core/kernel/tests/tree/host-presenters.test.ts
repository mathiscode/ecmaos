import { describe, expect, it } from 'vitest'
import type { WindowContent, WindowRenderer } from '@ecmaos/types'

import { WindowServer } from '#windowserver.ts'
import { hostPresenters } from '#lib/presenters/host.ts'
import type { Kernel } from '#kernel.ts'

/** A kernel with a window server whose renderer keeps what it is given, a filesystem of named files, and an opener */
function setup(files: Record<string, string | Uint8Array> = {}) {
  const windows = new WindowServer()
  const shown: Array<{ title: string, html?: string, content?: WindowContent }> = []
  const renderer: WindowRenderer = {
    supports: () => true, attach() {}, update() {}, close() {},
    create: (info, options) => { shown.push({ title: info.title, html: options.html }) },
    content: (_id, content) => { shown.at(-1)!.content = content }
  }
  windows.registerRenderer(renderer)
  const opened: string[] = []
  const kernel = {
    windows,
    filesystem: { fs: { readFile: async (path: string) => {
      const file = files[path]
      if (file === undefined) throw new Error(`ENOENT: ${path}`)
      return typeof file === 'string' ? new TextEncoder().encode(file) : file
    } } },
    host: { platform: { open: (url: string) => { opened.push(url) } } }
  } as unknown as Kernel
  return { kernel, shown, opened }
}

const run = (name: string, kernel: Kernel, params: Record<string, unknown>) => hostPresenters[name]!(kernel, undefined as never, params)

describe('presenters for a host with no page', () => {
  it('shows markdown as HTML in a window', async () => {
    const { kernel, shown } = setup({ '/a.md': '# Title\n\n<script>alert(1)</script>' })
    const out = await run('document', kernel, { path: '/a.md', file: 'a.md', windowTitle: 'a.md', options: {} })
    expect(out).toMatchObject({ result: { messages: [] } })
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'a.md', html: expect.stringContaining('<h1>Title</h1>') })
  })

  it('escapes JSON and reports invalid JSON as a message', async () => {
    const { kernel, shown } = setup({ '/ok.json': '{"a":"<b>"}', '/bad.json': '{' })
    await run('document', kernel, { path: '/ok.json', file: 'ok.json', options: {} })
    expect(shown[0]!.html).toContain('&#60;b&#62;')
    const bad = await run('document', kernel, { path: '/bad.json', file: 'bad.json', options: {} })
    expect(bad).toMatchObject({ result: { messages: [{ stream: 'err', text: expect.stringContaining('invalid JSON') }] } })
    expect(shown).toHaveLength(1)
  })

  it('shows an image and media from the file, and says what it cannot show', async () => {
    const { kernel, shown } = setup({ '/p.png': new Uint8Array([1, 2, 3]), '/s.mp3': new Uint8Array([4, 5]), '/x.bin': 'x' })
    await run('document', kernel, { path: '/p.png', file: 'p.png', options: {} })
    expect(shown[0]!.html).toContain('data:image/png;base64,AQID')
    expect(await run('audio', kernel, { path: '/s.mp3', title: 'Song', options: {} })).toEqual({ result: { duration: 0, metadataFailed: false } })
    expect(shown[1]).toMatchObject({ title: 'Song', html: expect.stringContaining('<audio src="data:audio/mpeg;base64,BAU=') })
    const other = await run('document', kernel, { path: '/x.bin', file: 'x.bin', options: {} })
    expect(other).toMatchObject({ result: { messages: [{ text: expect.stringContaining('cannot be shown') }] } })
    await expect(run('audio', kernel, { path: '/s.mp3', title: 'q', options: { quiet: true } })).rejects.toThrow(/needs a page/)
  })

  it('opens a web address in a window as a url', async () => {
    const { kernel, shown } = setup()
    await run('browser', kernel, { url: 'example.com/x' })
    expect(shown[0]).toMatchObject({ title: 'example.com', content: { url: 'https://example.com/x' } })
    expect(() => run('browser', kernel, { url: 'javascript:alert(1)' })).toThrow(/will not open/)
    expect(() => run('browser', kernel, { url: 'http://' })).toThrow(/invalid URL/)
  })

  it('hands only http, https and mailto addresses to the host opener', async () => {
    const { kernel, opened } = setup()
    await run('external', kernel, { url: 'https://example.com/a b' })
    await run('external', kernel, { url: 'mailto:a@example.com' })
    expect(opened).toEqual(['https://example.com/a%20b', 'mailto:a@example.com'])
    await expect(run('external', kernel, { url: 'file:///etc/passwd' })).rejects.toThrow(/will not open/)
    await expect(run('external', kernel, { url: 'nope' })).rejects.toThrow(/invalid URL/)
  })

  it('has no presenter for what needs a page', () => {
    for (const kind of ['clipboard-read', 'clipboard-write', 'speak', 'notify', 'download', 'upload', 'script']) expect(hostPresenters[kind]).toBeUndefined()
  })
})
