import { createRequire } from 'node:module'

import type { HostWindow, Launcher, LaunchOptions } from './launch.ts'

/** The part of `@webviewjs/webview` that is used */
interface WebviewWindow {
  createWebview(options: { url: string }): unknown
  setTitle(title: string): void
  close(): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
}

interface WebviewApplication {
  createBrowserWindow(options: { title: string, width: number, height: number, x?: number, y?: number, decorations: boolean }): WebviewWindow
  run(options: { ref: boolean }): void
}

export interface WebviewModule {
  Application: new () => WebviewApplication
}

/** Loads the optional `@webviewjs/webview`; `undefined` and the reason when it is not installed or its native library will not load */
export function loadWebview(): { module: WebviewModule } | { unavailable: string } {
  try {
    return { module: createRequire(import.meta.url)('@webviewjs/webview') as WebviewModule }
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message
    return { unavailable: `@webviewjs/webview could not be loaded (${cause.split('\n')[0]})` }
  }
}

/**
 * Native windows from the optional `@webviewjs/webview` (the system's own web view), in this process. One `Application`
 * serves every window. The close button asks instead of closing: the window is kept until the kernel agrees, which
 * `kill` then does, so a veto leaves it where it is.
 */
export function webviewLauncher(module: WebviewModule): Launcher {
  let app: WebviewApplication | undefined
  return {
    launch(url, geometry, title, options?: LaunchOptions): HostWindow {
      if (!app) {
        app = new module.Application()
        // the pump must not keep the process alive by itself
        app.run({ ref: false })
      }
      const window = app.createBrowserWindow({
        title,
        width: Math.max(100, Math.round(geometry.width)),
        height: Math.max(100, Math.round(geometry.height)),
        x: Math.round(geometry.x),
        y: Math.round(geometry.y),
        decorations: !options?.frameless
      })
      window.createWebview({ url })
      let done!: () => void
      const exited = new Promise<void>(resolve => { done = resolve })
      let closed = false
      const destroy = () => {
        if (closed) return
        closed = true
        try { window.close() } catch { /* already gone */ }
        done()
      }
      // the user used the close button: the window is destroyed and the machine is told, and it opens another if it refuses
      window.on('close', event => { event.preventDefault(); destroy() })
      return { kill: destroy, exited }
    }
  }
}
