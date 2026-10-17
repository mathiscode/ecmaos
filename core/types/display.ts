/**
 * The window display protocol: how a kernel's windows reach a display that is not the page the kernel runs in (a host
 * window of a Node process). A display page is scoped to one window; messages carry the window id so one page can later
 * host several. Messages are JSON, one per WebSocket text frame.
 */

import type { WindowGeometry, WindowId, WindowRenderer, WindowState } from './windows.ts'

/** What a window shows when no DOM element was mounted into it */
export type WindowContent =
  | { text: string }
  | { html: string }
  | { url: string }

/** Kernel to display */
export type ToDisplay =
  | { t: 'ready' }
  | { t: 'open', id: WindowId, title: string, geometry: WindowGeometry, state: WindowState, frameless: boolean, modal: boolean, content?: WindowContent }
  | { t: 'update', id: WindowId, title: string, geometry: WindowGeometry, state: WindowState }
  | { t: 'content', id: WindowId, content: WindowContent }
  | { t: 'close', id: WindowId }

/** Display to kernel. `hello` carries the one-time token and must be the first message */
export type ToKernel =
  | { t: 'hello', token: string }
  | { t: 'close-request', id: WindowId }
  | { t: 'changed', id: WindowId, state?: WindowState, geometry?: WindowGeometry, title?: string }
  | { t: 'focused', id: WindowId }

/** What a host offers for showing windows outside the kernel's own page */
export interface HostDisplay {
  /** Draws windows for the kernel's window server */
  readonly renderer: WindowRenderer
  /** Why windows cannot be shown on this host right now (no screen, no browser to host them); absent when they can */
  readonly unavailable?: string
  /** Closes every host window and the server behind them */
  close(): Promise<void>
}
