/**
 * Presenters: the main-thread half of a DOM-bound command.
 *
 * A worker-hosted program cannot touch the DOM, but most "GUI" commands (`open`, `video`, `web`,
 * ...) only do three things: parse arguments, read some bytes, and put something on screen. The
 * first two are ordinary program work; the third is what a presenter is. The program asks for one
 * through the `window_present` syscall (`#lib/main-thread-syscalls.ts`) with a *kind* and a JSON
 * parameter object, and the kernel runs the presenter registered for that kind on the main thread,
 * where the DOM lives. The surface is therefore an explicit list of kinds, not a general DOM proxy:
 * adding a capability means adding a presenter here and nothing else.
 *
 * A presenter gets the owning `Kernel` and the calling `Process`, and may return a `result` for
 * the program to report. Every presenter so far is fire-and-forget, like the commands they replace:
 * the program exits and the window (or download, or tab) carries on. `closed` exists for one that
 * must tie the process's lifetime to its window.
 */

import type { Process } from '@zenfs/linux'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import { presentApp } from './app.ts'
import { presentBrowser } from './browser.ts'
import { presentDocument } from './document.ts'
import { presentEditor } from './editor.ts'
import { presentAudio, presentVideo } from './media.ts'
import { presentExternal, presentDownload } from './open.ts'
import { presentScript } from './script.ts'
import { presentUpload } from './upload.ts'

export interface Presented {
  /** Anything the program should be told about what was presented (a duration, a final size). JSON-safe. */
  result?: unknown
  /**
   * For a presenter that owns something long-lived (an editor): resolves, with the final `result`,
   * when it is finished. `window_present` does not return to the program until then, so the process
   * lives exactly as long as the window. Absent for fire-and-forget kinds.
   */
  closed?: Promise<unknown>
  /** Called if the process ends first (`^C`, `kill`), so a still-open window goes with it. */
  dispose?: () => void
}

export type Presenter = (kernel: Kernel, proc: Process, params: Record<string, unknown>, shell?: Shell) => Promise<Presented | void> | Presented | void

export const presenters: Record<string, Presenter> = {
  external: presentExternal,
  download: presentDownload,
  video: presentVideo,
  audio: presentAudio,
  browser: presentBrowser,
  document: presentDocument,
  editor: presentEditor,
  app: presentApp,
  script: presentScript,
  upload: presentUpload
}
