/**
 * Window management types and interfaces
 *
 * `Windows` (`kernel.windows`) is a headless window server: it owns window state (identity, owner, geometry, state,
 * focus order) and delegates drawing to a `WindowRenderer`. A host with no renderer for a window kind cannot open
 * windows of that kind.
 */

import type { WindowContent } from './display.ts'

/** Window identifier type */
export type WindowId = string | number

/** What a window shows. `web` is DOM content; further kinds (terminals, pixel surfaces) are added by later phases */
export type WindowKind = 'web'

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen'

/** A position or size: pixels, or a string such as `'center'` or `'50%'` that the renderer resolves */
export type WindowLength = number | string

export interface WindowOwner {
  pid: number
  uid: number
  gid: number
}

/** Space at the edges of the display that windows keep out of, for a taskbar or panel */
export interface WindowInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Where a minimized window goes: `dock` is the renderer's own strip of minimized windows; `hidden` leaves a shell (a taskbar) to show them */
export type MinimizeMode = 'dock' | 'hidden'

export interface WindowGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** The server's record of a window; renderers receive and report this */
export interface WindowInfo {
  id: WindowId
  title: string
  kind: WindowKind
  owner: WindowOwner
  state: WindowState
  geometry: WindowGeometry
  focused: boolean
  modal: boolean
  frameless: boolean
  icon?: string
  /** The workspace the window is on (0 is the first) */
  workspace: number
  /** On a workspace other than the current one, so a renderer does not draw it */
  hidden: boolean
  /** `Date.now()` at creation */
  created: number
}

/**
 * Options for creating a window
 */
export interface WindowOptions {
  title?: string
  kind?: WindowKind
  /** Defaults to a generated id */
  id?: WindowId
  x?: WindowLength
  y?: WindowLength
  width?: WindowLength
  height?: WindowLength
  /** Start maximized */
  max?: boolean
  modal?: boolean
  /** Ask for no host chrome; a renderer may ignore it */
  frameless?: boolean
  /** Window icon */
  icon?: URL | string
  /** CSS class for the window (DOM renderers) */
  class?: string
  /** Initial HTML content (DOM renderers) */
  html?: string
  /** Defaults to the kernel (`{ pid: 0, uid: 0, gid: 0 }`); syscalls pass the calling process */
  owner?: WindowOwner
  /** Called when the user asks to close the window; return `true` to keep it open */
  onclose?: (force?: boolean) => boolean | void
}

/**
 * A window as seen by its creator
 */
export interface WindowHandle {
  readonly id: WindowId
  /** A snapshot of the server's record */
  readonly info: WindowInfo
  /** The content element. Only available when the renderer draws with the DOM; otherwise throws ENODEV */
  readonly body: HTMLElement
  /** The outermost element, as `body`. */
  readonly dom: HTMLElement
  /** Appends `element` to the window's content, as `body`. */
  mount(element: HTMLElement): void
  /** Sets what the window shows, for a renderer that has no DOM element to mount into (a host window); throws ENODEV when the renderer cannot */
  setContent(content: WindowContent): void
  setTitle(title: string): void
  move(x: number, y: number): void
  resize(width: number, height: number): void
  setState(state: WindowState): void
  focus(): void
  close(force?: boolean): void
  /** Sets who answers the calls that content running in the window makes (an app in a host window's sandbox) */
  onCall(handler: ((op: string, args: unknown[]) => Promise<unknown> | unknown) | undefined): void
}

/**
 * Draws windows for a window server. The renderer tells the server about changes the user makes
 * (minimizing, moving, closing) by calling the `WindowReports` it is given in `attach`.
 */
export interface WindowRenderer {
  supports(kind: WindowKind): boolean
  /** Receives the callbacks used to report user actions */
  attach(reports: WindowReports): void
  /** Draws a new window and returns the renderer's content element for DOM renderers */
  create(info: WindowInfo, options: WindowOptions): { body?: HTMLElement, dom?: HTMLElement } | void
  update(info: WindowInfo): void
  close(id: WindowId): void
  /** Shows `content` in a window drawn without the DOM; absent on renderers that mount elements */
  content?(id: WindowId, content: WindowContent): void
  /** The work area changed; windows opened from now on keep to it, and maximized ones fit it */
  workareaChanged?(insets: WindowInsets): void
  /** The minimize mode changed; minimized windows move between the dock and hiding */
  minimizeModeChanged?(mode: MinimizeMode): void
}

/**
 * What the user did inside a window that draws pixels (a framebuffer window). Positions are in the window's own pixels.
 * `focus` and `blur` are keyboard focus; `enter` and `leave` are the pointer.
 */
export type WindowInput =
  | { k: 'key', code: string, down: boolean, repeat?: boolean }
  | { k: 'pointer', x: number, y: number }
  | { k: 'button', button: number, down: boolean }
  | { k: 'wheel', dx: number, dy: number }
  | { k: 'enter' | 'leave' | 'focus' | 'blur' }

/** Callbacks a renderer uses to report what happened to a window */
export interface WindowReports {
  /** The user did something inside a pixel window */
  input(id: WindowId, input: WindowInput): void
  /** The user asked to close; the server may veto. Returns whether the window was closed */
  closeRequested(id: WindowId, force?: boolean): boolean
  /** Reports state, geometry or title changes made by the user */
  changed(id: WindowId, patch: Partial<Pick<WindowInfo, 'state' | 'geometry' | 'title'>>): void
  focused(id: WindowId): void
  /** Content running in the window asks for something; resolves to the answer */
  call(id: WindowId, op: string, args: unknown[]): Promise<unknown>
  /** The current work area, for a renderer placing a new window */
  workarea(): WindowInsets
  /** The current minimize mode */
  minimizeMode(): MinimizeMode
}

export type WindowEvent = 'create' | 'update' | 'focus' | 'close'

/**
 * The window server, available as `kernel.windows`
 */
export interface Windows {
  /** Per-process window limit */
  maxPerProcess: number

  /** The edges windows keep out of; all zero until a panel sets it */
  readonly workarea: WindowInsets

  /** Reserves space at the edges of the display (a taskbar); pass zeros to release it */
  setWorkarea(insets: Partial<WindowInsets>): void

  /** Where minimized windows go; `dock` until a shell that shows them itself (a taskbar) sets `hidden` */
  readonly minimizeMode: MinimizeMode

  /** Sets where minimized windows go. The windows keep the `minimized` state either way; a shell restores one with `focus` */
  setMinimizeMode(mode: MinimizeMode): void

  /** How many workspaces there are (at least 1) and the one being shown, 0-based */
  readonly workspaces: number
  readonly workspace: number

  /** Sets how many workspaces there are; windows on a removed one move to the last. Counts from 1 to 16 */
  setWorkspaceCount(count: number): void

  /** Shows a workspace: the windows on it are drawn, the others hidden, and the topmost window on it is focused */
  switchWorkspace(workspace: number): void

  /** Moves a window to a workspace; it is hidden if that is not the current one */
  moveToWorkspace(id: WindowId, workspace: number): void

  /** Subscribe to workspace changes (a switch or a new count); returns an unsubscribe function */
  onWorkspace(listener: (workspace: number, count: number) => void): () => void

  /** Adds a renderer; the most recently added renderer that supports a kind is used for it */
  registerRenderer(renderer: WindowRenderer): void

  /** Create a window. Throws ENODEV when no renderer supports the kind, EMFILE past the per-process limit */
  create(options?: WindowOptions): WindowHandle

  /** Create a modal dialog window */
  dialog(options?: WindowOptions): WindowHandle

  /** Get a window by ID */
  get(id: WindowId): WindowHandle | undefined

  /** Window records, bottom to top. Pass `owner` to list one process's windows */
  list(filter?: { pid?: number, uid?: number }): WindowInfo[]

  /** Raise and focus a window */
  focus(id: WindowId): void

  /** Reports what the user did inside a pixel window drawn with the DOM (other renderers use `WindowReports.input`) */
  reportInput(id: WindowId, input: WindowInput): void

  /** Calls `listener` with what the user does inside a pixel window; returns the function that stops it */
  onInput(id: WindowId, listener: (input: WindowInput) => void): () => void

  /** Change a window's title, geometry or state */
  update(id: WindowId, patch: Partial<Pick<WindowInfo, 'state' | 'title'>> & Partial<WindowGeometry>): void

  /**
   * Close a window; an `onclose` that returns `true` keeps it open unless `force`
   * @returns whether the window was closed
   */
  close(id: WindowId, force?: boolean): boolean

  /** Close every window a process owns (called when it exits) */
  closeOwnedBy(pid: number): void

  /** Subscribe to window events; returns an unsubscribe function */
  on(event: WindowEvent, listener: (info: WindowInfo) => void): () => void

  /** Subscribe to work area changes; returns an unsubscribe function */
  onWorkarea(listener: (insets: WindowInsets) => void): () => void
}

/** Options for a window with a terminal emulator running a program on a pty */
export interface TerminalWindowOptions {
  /** The user the program runs as */
  username: string
  /** A login prompt (`/sbin/getty`) instead of a shell: the user at the keyboard names who they are. `username` is then who runs the prompt, root */
  login?: boolean
  /** Defaults to the user's login shell, `/bin/ecmash -l` */
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  title?: string
  /** The window's owner; defaults to the kernel, so the window outlives whatever opened it */
  owner?: WindowOwner
  width?: number
  height?: number
}

/** A terminal window: closing it hangs the program up, and the program exiting closes it */
export interface TerminalWindowHandle {
  window: WindowHandle
  /** Resolves to the program's exit code */
  exited: Promise<number>
}

/** Options for running a program with no window */
export interface DetachedOptions {
  username: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}
