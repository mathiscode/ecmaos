/**
 * The presenters a display can run for a program on its tty. Browser calls that need the visible page (clipboard,
 * notifications, speech, a new tab, a download, the file picker) are done by the attached display when there is one
 * (`lib/remote-display.ts`). A kind has up to three parts: `prepare` (in the owner) turns the parameters into what
 * the display needs, `run` (in the display) does it, `finish` (in the owner) handles the answer. The display imports
 * only `run`, so nothing here may reach for the kernel at run time. Presenters that put a window on the owner's page
 * are not here.
 */

import type { Process } from '@zenfs/linux'

import type { Shell } from '@ecmaos/types'
import { KernelEvents } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import { presentClipboardRead, presentClipboardWrite, presentNotify, presentSpeak } from './bridge.ts'
import { AUDIO_MIME, VIDEO_MIME, mimeType } from './media.ts'
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

/** Plays media in a full-page overlay of the display (it has no window manager); Escape or the button closes it */
async function runMedia(params: Params): Promise<Presented> {
  const bytes = params['bytes']
  if (!(bytes instanceof Uint8Array)) throw new Error('missing file')
  const video = params['kind'] === 'video'
  const options = (params['options'] ?? {}) as { autoplay?: boolean, loop?: boolean, muted?: boolean, volume?: number, quiet?: boolean }
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: String(params['type'] ?? '') }))
  const element = document.createElement(video ? 'video' : 'audio')
  element.src = url
  element.preload = 'metadata'
  element.controls = !options.quiet
  element.autoplay = !!options.autoplay
  element.loop = !!options.loop
  element.muted = !!options.muted
  if (typeof options.volume === 'number') element.volume = options.volume / 100

  let duration = 0
  let metadataFailed = false
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10_000)
      element.onloadedmetadata = () => { clearTimeout(timer); resolve() }
      element.onerror = () => { clearTimeout(timer); reject(new Error('failed')) }
    })
    duration = element.duration
  } catch { metadataFailed = true }

  if (options.quiet) {
    element.play().catch(() => {})
    return { result: { duration, metadataFailed, quiet: true } }
  }

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.92);color:#e6e6e6;font:14px monospace;padding:16px'
  const title = document.createElement('div')
  title.textContent = String(params['name'] ?? '')
  element.style.cssText = video ? 'max-width:100%;max-height:85vh' : 'width:100%;max-width:600px'
  const close = document.createElement('button')
  close.textContent = 'Close (Esc)'
  const closed = new Promise<unknown>(resolve => {
    const done = () => { element.pause(); overlay.remove(); URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey, true); resolve({ duration, metadataFailed, quiet: false }) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') done() }
    document.addEventListener('keydown', onKey, true)
    close.onclick = done
    ;(overlay as HTMLElement & { done?: () => void }).done = done
  })
  overlay.append(title, element, close)
  document.body.append(overlay)
  // the program ends when the player is closed, as a window's does
  return { closed, dispose: () => (overlay as HTMLElement & { done?: () => void }).done?.() }
}

const mediaKind = (kind: 'video' | 'audio'): RemoteKind => ({
  prepare: async (kernel, _proc, params) => {
    const path = params['path']
    if (typeof path !== 'string' || !path) throw new Error('missing path')
    const table = kind === 'video' ? VIDEO_MIME : AUDIO_MIME
    return { ...params, kind, name: typeof params['name'] === 'string' ? params['name'] : path.split('/').pop(), type: mimeType(table, kind === 'video' ? 'video/mp4' : 'audio/mpeg', path), bytes: new Uint8Array(await kernel.filesystem.fs.readFile(path)) }
  },
  run: runMedia
})

export const remoteKinds: Record<string, RemoteKind> = {
  notify: { run: params => presentNotify(undefined as never, undefined, params) },
  'clipboard-write': { run: params => presentClipboardWrite(undefined as never, undefined, params) },
  'clipboard-read': { run: () => presentClipboardRead() },
  speak: { run: params => presentSpeak(undefined as never, undefined, params) },
  video: mediaKind('video'),
  audio: mediaKind('audio'),
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
