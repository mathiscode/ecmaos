/**
 * The presenters a display can run for a program on its tty.
 *
 * Browser calls that need the page the user is looking at (the clipboard, notifications, speech, a new tab, a download, the file
 * picker) are done by the display attached to the program's tty when there is one, since the owner's tab may be in the background
 * (see `lib/remote-display.ts`). Each kind has up to three parts: `prepare` runs in the owner and turns the program's parameters into
 * what the display needs (bytes it cannot read for itself), `run` runs in the display, and `finish` runs in the owner on what the
 * display answered (writing the files it picked). The display imports only `run`, so nothing here may reach for the kernel at run time.
 *
 * Presenters that put a window on the owner's page (`document`, `app`, `browser`, `video`, `audio`) are not here: they read the
 * machine's files and use its window manager, which a display does not have.
 */

import type { Process } from '@zenfs/linux'

import type { Shell } from '@ecmaos/types'
import { KernelEvents } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import { presentClipboardRead, presentClipboardWrite, presentNotify, presentSpeak } from './bridge.ts'
import type { Presented } from './index.ts'

type Params = Record<string, unknown>

export interface RemoteKind {
  /** In the owner: the parameters the display is sent */
  prepare?(kernel: Kernel, proc: Process, params: Params, shell?: Shell): Promise<Params> | Params
  /** In the display: does it */
  run(params: Params): Promise<Presented | void> | Presented | void
  /** In the owner: turns the display's answer into the program's result */
  finish?(kernel: Kernel, shell: Shell | undefined, answer: unknown, params: Params): Promise<unknown> | unknown
}

/** Opens `url` in a new tab */
function runExternal(params: Params): void {
  const url = params['url']
  if (typeof url !== 'string' || !url) throw new Error('missing url')
  window.open(url, '_blank')
}

/** Hands bytes to the browser as a download */
function runDownload(params: Params): void {
  const bytes = params['bytes']
  const name = params['name']
  if (!(bytes instanceof Uint8Array)) throw new Error('missing file')
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = typeof name === 'string' && name ? name : 'download'
  a.click()
  window.URL.revokeObjectURL(url)
}

interface Picked { name: string, data: Uint8Array }

/** The browser's file picker; answers with the files' bytes, `null` when cancelled */
function runPick(): Presented {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '*'
  input.multiple = true
  const closed = new Promise<Picked[] | null>((resolve, reject) => {
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', async () => {
      try { resolve(await Promise.all(Array.from(input.files ?? []).map(async file => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })))) }
      catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
    })
  })
  input.click()
  return { closed, dispose: () => input.remove() }
}

export const remoteKinds: Record<string, RemoteKind> = {
  notify: { run: params => presentNotify(undefined as never, undefined, params) },
  'clipboard-write': { run: params => presentClipboardWrite(undefined as never, undefined, params) },
  'clipboard-read': { run: () => presentClipboardRead() },
  speak: { run: params => presentSpeak(undefined as never, undefined, params) },
  external: { run: runExternal },
  download: {
    prepare: async (kernel, _proc, params) => {
      const path = params['path']
      if (typeof path !== 'string' || !path) throw new Error('missing path')
      return { name: path.split('/').pop() || 'download', bytes: new Uint8Array(await kernel.filesystem.fs.readFile(path)) }
    },
    run: runDownload
  },
  upload: {
    run: runPick,
    finish: async (kernel, shell, answer, params) => {
      const directory = params['directory']
      if (typeof directory !== 'string' || !directory) throw new Error('missing directory')
      if (!shell) throw new Error('no shell')
      const outcome: { uploaded: string[], errors: string[] } = { uploaded: [], errors: [] }
      const files = Array.isArray(answer) ? answer as Picked[] : []
      if (Array.isArray(answer) && files.length === 0) outcome.errors.push('No file selected')
      for (const file of files) {
        try {
          const destination = `${directory.replace(/\/$/, '')}/${file.name}`
          await shell.context.fs.promises.writeFile(destination, file.data)
          kernel.events.dispatch(KernelEvents.UPLOAD, { file: file.name, path: destination })
          outcome.uploaded.push(file.name)
        } catch (error) {
          outcome.errors.push(`Failed to upload ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      }
      return outcome
    }
  }
}
