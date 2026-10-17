/**
 * The window display protocol: how a kernel's windows reach a display that is not the page the kernel runs in (a host
 * window of a Node process). A display page is scoped to one window; messages carry the window id so one page can later
 * host several. Messages are JSON, one per WebSocket text frame.
 */

import type { WindowGeometry, WindowId, WindowInput, WindowRenderer, WindowState } from './windows.ts'

/** An app to run inside a window's sandbox (see `AppSdk`): its code, and what it is told about the process that started it */
export interface AppLaunch {
  /** An ES module whose `display` export (or default export) is called with the `AppSdk` */
  source: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  pid: number
  uid: number
  gid: number
}

/** What a window shows when no DOM element was mounted into it */
export type WindowContent =
  | { text: string }
  | { html: string }
  | { url: string }
  | { app: AppLaunch }
  /** A frame of pixels (a framebuffer's window): `width * height` of them, 4 bytes each (blue, green, red, unused), base64 */
  | { pixels: { width: number, height: number, data: string } }

/** Kernel to display */
export type ToDisplay =
  | { t: 'ready' }
  | { t: 'open', id: WindowId, title: string, geometry: WindowGeometry, state: WindowState, frameless: boolean, modal: boolean, content?: WindowContent }
  | { t: 'update', id: WindowId, title: string, geometry: WindowGeometry, state: WindowState }
  | { t: 'content', id: WindowId, content: WindowContent }
  | { t: 'close', id: WindowId }
  /** The answer to a `call` of the same `call` number */
  | { t: 'result', id: WindowId, call: number, result?: unknown, error?: string }

/** Display to kernel. `hello` carries the one-time token and must be the first message */
export type ToKernel =
  | { t: 'hello', token: string }
  | { t: 'close-request', id: WindowId }
  | { t: 'changed', id: WindowId, state?: WindowState, geometry?: WindowGeometry, title?: string }
  | { t: 'focused', id: WindowId }
  /** The user did something inside a pixel window */
  | { t: 'input', id: WindowId, input: WindowInput }
  /** An app in the window's sandbox asks the kernel to do something for it (see `AppSdk`); bytes travel as `{ $bytes: base64 }` */
  | { t: 'call', id: WindowId, call: number, op: string, args: unknown[] }

/** What a host offers for showing windows outside the kernel's own page */
export interface HostDisplay {
  /** Draws windows for the kernel's window server */
  readonly renderer: WindowRenderer
  /** Why windows cannot be shown on this host right now (no screen, no browser to host them); absent when they can */
  readonly unavailable?: string
  /** Closes every host window and the server behind them */
  close(): Promise<void>
}
