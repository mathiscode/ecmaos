import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { preview, type PreviewServer } from 'vite'

const root = path.resolve(import.meta.dirname, '../..')
const shots = path.join(root, 'test-results')

/* eslint-disable @typescript-eslint/no-explicit-any -- `ecmaos` is the page's debug global, typed only in the page */
declare const ecmaos: any

const until = async (check: () => Promise<boolean>, ms = 30_000, what = String(check)) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A booted site in a fresh profile, driven like a person would: typing at the prompt, clicking a window */
describe('the site in a real browser', () => {
  let server: PreviewServer
  let browser: Browser
  let page: Page

  // `ecmaos` is defined once the kernel is running
  const screen = () => page.evaluate(() => {
    if (!('ecmaos' in globalThis)) return ''
    const buffer = ecmaos.terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n').trimEnd()
  })
  const read = (file: string) => page.evaluate(file => ecmaos.fs.readFile(file, 'utf-8').catch(() => ''), file) as Promise<string>
  // the terminal's lines come without their trailing spaces
  const atPrompt = async () => (await screen()).split('\n').at(-1) === 'root:/root#'
  const type = async (line: string) => {
    await until(atPrompt, 30_000, 'the prompt')
    await page.keyboard.type(line)
    await page.keyboard.press('Enter')
  }
  /** blue, green, red of the first framebuffer's top left pixel */
  const framebufferColor = () => page.evaluate(() => [...ecmaos.kernel.framebuffers.list()[0]?.pixels.subarray(0, 3) ?? []].join())
  /** red, green, blue of the top left pixel the page shows in the window's canvas */
  const canvasColor = (title: string) => page.evaluate(title => {
    const box = [...document.querySelectorAll('.winbox')].find(box => box.querySelector('.wb-title')?.textContent === title)
    const canvas = box?.querySelector('canvas')
    return canvas ? [...canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data.subarray(0, 3)].join() : ''
  }, title)

  beforeAll(async () => {
    if (!existsSync(path.join(root, 'dist/index.html'))) throw new Error('no built site: run `pnpm build` in core/kernel first')
    server = await preview({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', preview: { port: 0, open: false } })
    // SwiftShader gives a headless browser with no GPU its WebGL2
    browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  })

  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || !page) return
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, `${task.name.replace(/\W+/g, '-')}.png`) })
  })

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })

  it('boots from an empty profile and asks about the recommended apps', async () => {
    await page.goto(server.resolvedUrls!.local[0]!)
    await until(async () => (await screen()).includes('(Y/n)'), 200_000, 'the recommended apps question')
    expect(await page.evaluate(() => ecmaos.kernel.state)).toBe('running')
  })

  it('takes what is typed at the prompt', async () => {
    await page.keyboard.type('n')
    await page.keyboard.press('Enter')
    await type('echo typed at the keyboard > /tmp/typed.txt')
    await until(async () => (await read('/tmp/typed.txt')) !== '', 10_000, '/tmp/typed.txt')
    expect(await read('/tmp/typed.txt')).toBe('typed at the keyboard\n')
  })

  it('runs a WASI Preview 2 component', async () => {
    const bytes = readFileSync(path.join(root, 'tests/tree/wasi/fixtures/p2-echo.wasm')).toString('base64')
    await page.evaluate(bytes => ecmaos.fs.writeFile('/tmp/p2-echo.wasm', Uint8Array.from(atob(bytes), c => c.charCodeAt(0)), { mode: 0o755 }), bytes)
    await page.evaluate(() => ecmaos.fs.writeFile('/tmp/p2.in', 'from stdin\n'))
    await type('/tmp/p2-echo.wasm one two < /tmp/p2.in > /tmp/p2.out 2> /tmp/p2.err')
    await until(async () => (await read('/tmp/p2.err')) !== '', 30_000, 'the component to finish')
    expect(await read('/tmp/p2.out')).toBe('one\ntwo\nfrom stdin\n')
    expect(await read('/tmp/p2.err')).toBe('p2-echo: done\n')
  })

  it('shows an OpenGL ES program in a window, drawn by the browser\'s WebGL2', async () => {
    await type('wlcomp > /tmp/wlcomp.out 2>&1 &')
    await until(async () => (await read('/tmp/wlcomp.out')).includes('listening'), 60_000, 'wlcomp')
    await type('sdlgl 160 120 > /tmp/sdlgl.out 2>&1 &')
    await until(async () => (await read('/tmp/sdlgl.out')).includes('WebGL2 through /dev/gl'), 90_000, 'sdlgl to start')
    // the first frame clears to gray 0.2, rendered by the browser and read back into the framebuffer
    await until(async () => (await framebufferColor()) === '51,51,51', 30_000, 'the gray frame')
    await until(async () => (await canvasColor('sdlgl')) === '51,51,51', 10_000, 'the gray frame on the page')
  })

  it('sends keys to the window that was clicked', async () => {
    const box = page.locator('.winbox', { has: page.locator('.wb-title', { hasText: 'sdlgl' }) })
    await box.locator('canvas').click()
    await page.keyboard.press('r')
    await until(async () => (await read('/tmp/sdlgl.out')).includes('sdlgl: red'), 10_000, 'the program to see the key')
    await until(async () => (await framebufferColor()) === '0,0,255', 10_000, 'the red frame')
    await until(async () => (await canvasColor('sdlgl')) === '255,0,0', 10_000, 'the red frame on the page')
  })

  it('ends the program when its window is closed', async () => {
    const box = page.locator('.winbox', { has: page.locator('.wb-title', { hasText: 'sdlgl' }) })
    await box.locator('.wb-close').click()
    await until(() => page.evaluate(() => ecmaos.kernel.framebuffers.list().length === 0), 20_000, 'the window to go')
    await until(() => page.evaluate(() => ecmaos.kernel.windows.list().length === 0), 20_000, 'the window list to empty')
    expect(await read('/tmp/sdlgl.out')).not.toContain('ERROR')
  })
})
