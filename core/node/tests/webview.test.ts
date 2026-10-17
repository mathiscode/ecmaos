import { describe, expect, it } from 'vitest'

import { defaultLauncher, webviewLauncher } from '../src/display/index.ts'
import type { WebviewModule } from '../src/display/webview.ts'

const geometry = { x: 10, y: 20, width: 300, height: 200 }

function fake() {
  const windows: Array<{ options: Record<string, unknown>, url?: string, closed: number, close(): void, fire(): boolean }> = []
  const module: WebviewModule = {
    Application: class {
      static runs = 0
      createBrowserWindow(options: Record<string, unknown>) {
        let listener: ((event: { preventDefault(): void }) => void) | undefined
        const record = {
          options, closed: 0, url: undefined as string | undefined,
          close() { record.closed++ },
          fire() { let prevented = false; listener?.({ preventDefault() { prevented = true } }); return prevented }
        }
        windows.push(record)
        return {
          createWebview(o: { url: string }) { record.url = o.url },
          setTitle() {},
          close: () => record.close(),
          on: (_event: 'close', l: typeof listener) => { listener = l }
        } as never
      }
      run() { (this.constructor as unknown as { runs: number }).runs++ }
    } as never
  }
  return { module, windows }
}

describe('webview launcher', () => {
  it('opens a decorated window on the url, and frameless when asked', () => {
    const { module, windows } = fake()
    const launcher = webviewLauncher(module)
    launcher.launch('http://127.0.0.1:1/#a', geometry, 'one')
    launcher.launch('http://127.0.0.1:1/#b', geometry, 'two', { frameless: true })
    expect(windows.map(w => w.url)).toEqual(['http://127.0.0.1:1/#a', 'http://127.0.0.1:1/#b'])
    expect(windows.map(w => w.options['decorations'])).toEqual([true, false])
    expect(windows[0]!.options).toMatchObject({ title: 'one', width: 300, height: 200, x: 10, y: 20 })
  })

  it('destroys the window itself when the close button is used, and once', async () => {
    const { module, windows } = fake()
    const host = webviewLauncher(module).launch('http://x/', geometry, 't')
    expect(windows[0]!.fire()).toBe(true)
    await host.exited
    expect(windows[0]!.closed).toBe(1)
    host.kill()
    expect(windows[0]!.closed).toBe(1)
  })

  it('kill closes the window and ends exited', async () => {
    const { module, windows } = fake()
    const host = webviewLauncher(module).launch('http://x/', geometry, 't')
    host.kill()
    await host.exited
    expect(windows[0]!.closed).toBe(1)
  })
})

describe('defaultLauncher', () => {
  const ok = { DISPLAY: ':0' } as NodeJS.ProcessEnv
  const loaded = () => ({ module: fake().module })
  const none = () => ({ unavailable: 'not installed' })

  it('uses the webview when it loads', () => {
    expect(defaultLauncher(ok, loaded).unavailable).toBeUndefined()
    // told apart from the browser launcher by not needing a browser to exist
    expect(defaultLauncher({ ...ok, PATH: '' }, loaded).unavailable).toBeUndefined()
  })

  it('falls back to the browser when it does not load', () => {
    expect(defaultLauncher({ ...ok, PATH: '' }, none).unavailable).toMatch(/no Chromium-based browser/)
  })

  it('keeps the browser when one is named or the webview is off', () => {
    expect(defaultLauncher({ ...ok, PATH: '', ECMAOS_WEBVIEW: '0' }, loaded).unavailable).toMatch(/no Chromium-based browser/)
    expect(defaultLauncher({ ...ok, ECMAOS_BROWSER: '/nope' }, loaded).unavailable).toMatch(/ECMAOS_BROWSER/)
  })

  it('reports no display and the off switch, whatever the webview', () => {
    expect(defaultLauncher({ PATH: '' } as NodeJS.ProcessEnv, loaded).unavailable).toMatch(/no display/)
    expect(defaultLauncher({ ...ok, ECMAOS_DISPLAY: '0' }, loaded).unavailable).toMatch(/turned off/)
  })
})
