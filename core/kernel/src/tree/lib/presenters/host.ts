/**
 * Presenters for a host that shows windows but has no page of its own (a Node process): they build the content as
 * HTML and give it to the host's display (`WindowHandle.setContent`) instead of mounting DOM elements. A kind that
 * needs the page (the clipboard, speech, notifications, a download, a DOM app) is not here and fails with a clear
 * message; a host with a display page for it can take those over later.
 */

import { marked } from 'marked'

import type { Kernel } from '#kernel.ts'

import { serveApp } from '#lib/app-host.ts'
import { detectFileType, getMimeType } from './document.ts'
import { AUDIO_MIME, VIDEO_MIME, mimeType } from './media.ts'
import type { Presented, Presenter } from './index.ts'

/** Media goes to the display inside the page; past this the message would be too large to send as one */
const MaxInline = 64 * 1024 * 1024

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value) throw new Error(`missing ${name}`)
  return value
}

const page = (body: string, style = '') => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#1e1e1e;color:#e0e0e0;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}${style}</style>${body}`

const markdownStyle = `
  .doc{max-width:800px;margin:0 auto;padding:40px}
  h1,h2,h3,h4,h5,h6{color:#fff;margin:1.5em 0 .5em}h1,h2{border-bottom:1px solid #444;padding-bottom:.3em}
  code{background:#2d2d2d;padding:2px 6px;border-radius:3px;font-family:monospace;color:#f8f8f2}
  pre{background:#2d2d2d;padding:16px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}
  a{color:#4a9eff}blockquote{border-left:4px solid #4a9eff;padding-left:16px;margin-left:0;color:#b0b0b0}
  table{border-collapse:collapse;width:100%}th,td{border:1px solid #444;padding:8px 12px;text-align:left}th{background:#2d2d2d}
  img{max-width:100%;height:auto}hr{border:none;border-top:1px solid #444}`

function base64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

async function dataUrl(kernel: Kernel, path: string, type: string) {
  const bytes = new Uint8Array(await kernel.filesystem.fs.readFile(path))
  if (bytes.length > MaxInline) throw new Error(`${path} is too large to show here (${Math.round(bytes.length / 1048576)} MiB; the limit is ${MaxInline / 1048576} MiB)`)
  return `data:${type};base64,${base64(bytes)}`
}

const show = (kernel: Kernel, title: string, html: string, width = 900, height = 700): Presented => {
  kernel.windows.create({ title, html, width, height })
  return {}
}

const presentExternal: Presenter = async (kernel, _proc, params) => {
  const target = text(params['url'], 'url')
  let url: URL
  try { url = new URL(target) } catch { throw new Error(`invalid URL: ${target}`) }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error(`will not open a ${url.protocol} address`)
  const open = kernel.host.platform.open
  if (!open) throw new Error('this host cannot open an address')
  await open(url.href)
}

const presentBrowser: Presenter = (kernel, _proc, params) => {
  const raw = text(params['url'], 'url')
  const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw) ? raw : `https://${raw}`
  let url: URL
  try { url = new URL(normalized) } catch { throw new Error(`invalid URL: ${raw}`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`will not open a ${url.protocol} address in a window`)
  kernel.windows.create({ title: url.hostname || url.href }).setContent({ url: url.href })
  return {}
}

const presentDocument: Presenter = async (kernel, _proc, params) => {
  const path = text(params['path'], 'path')
  const file = text(params['file'], 'file')
  const title = typeof params['windowTitle'] === 'string' && params['windowTitle'] ? params['windowTitle'] : file
  const type = detectFileType(path)
  const messages: Array<{ stream: 'out' | 'err', text: string }> = []

  if (type === 'markdown') {
    const html = await marked.parse(new TextDecoder().decode(await kernel.filesystem.fs.readFile(path)), { async: true })
    show(kernel, title, page(`<div class="doc">${html}</div>`, markdownStyle))
  } else if (type === 'json') {
    let formatted: string
    try { formatted = JSON.stringify(JSON.parse(new TextDecoder().decode(await kernel.filesystem.fs.readFile(path))), null, 2) } catch (error) {
      messages.push({ stream: 'err', text: `view: invalid JSON in ${file}: ${error instanceof Error ? error.message : 'Unknown error'}` })
      return { result: { messages } }
    }
    show(kernel, title, page(`<pre style="margin:0;padding:16px;white-space:pre-wrap">${escapeHtml(formatted)}</pre>`))
  } else if (type === 'image') {
    show(kernel, title, page(`<img src="${await dataUrl(kernel, path, getMimeType(path, type))}" style="width:100%;height:100%;object-fit:contain">`))
  } else if (type === 'audio' || type === 'video') {
    const src = await dataUrl(kernel, path, getMimeType(path, type))
    const options = (params['options'] ?? {}) as { autoplay?: boolean, loop?: boolean, muted?: boolean }
    const attrs = `controls ${options.autoplay ? 'autoplay' : ''} ${options.loop ? 'loop' : ''} ${options.muted ? 'muted' : ''}`
    show(kernel, title, page(`<${type} src="${src}" ${attrs} style="width:100%;height:100%;object-fit:contain"></${type}>`))
  } else {
    messages.push({ stream: 'err', text: `view: ${file}: cannot be shown in a window on this host (${type})` })
  }
  return { result: { messages } }
}

const presentMedia = (kind: 'video' | 'audio'): Presenter => async (kernel, _proc, params) => {
  const path = text(params['path'], 'path')
  const title = typeof params['title'] === 'string' && params['title'] ? params['title'] : path.split('/').pop() ?? kind
  const options = (params['options'] ?? {}) as { autoplay?: boolean, controls?: boolean, loop?: boolean, muted?: boolean, quiet?: boolean, width?: number, height?: number }
  if (options.quiet) throw new Error('background playback needs a page; this host has none')
  const src = await dataUrl(kernel, path, mimeType(kind === 'video' ? VIDEO_MIME : AUDIO_MIME, kind === 'video' ? 'video/mp4' : 'audio/mpeg', path))
  const attrs = `controls ${options.autoplay ? 'autoplay' : ''} ${options.loop ? 'loop' : ''} ${options.muted ? 'muted' : ''}`
  show(kernel, title, page(`<${kind} src="${src}" ${attrs} style="width:100%;height:100%;object-fit:contain"></${kind}>`), options.width ?? (kind === 'video' ? 800 : 480), options.height ?? (kind === 'video' ? 450 : 120))
  return { result: { duration: 0, metadataFailed: false } }
}

/**
 * A DOM app (`#!ecmaos:bin:app:<name>`) on a host with no page: its code runs in the sandbox of a window on the display and
 * reaches the machine only through the `AppSdk`. The app needs a `display` export; one written only for the kernel's own
 * page (`main(params)`) fails when it starts, and the window closes with exit code 1.
 */
const presentApp: Presenter = async (kernel, proc, params, shell) => {
  const file = text(params['file'], 'file')
  const args = Array.isArray(params['args']) ? params['args'].map(String) : []
  const command = typeof params['command'] === 'string' && params['command'] ? params['command'] : file.split('/').pop() ?? 'app'
  const source = await kernel.filesystem.fs.readFile(file, 'utf-8')

  const { uid, gid } = proc.context.credentials
  const launch = {
    source, command, args,
    cwd: shell?.cwd ?? proc.context.pwd ?? '/',
    env: shell?.envObject ?? {},
    pid: proc.pid, uid: proc.context.credentials.euid ?? uid, gid: proc.context.credentials.egid ?? gid
  }
  const win = kernel.windows.create({ title: command, width: 900, height: 600, owner: { pid: proc.pid, uid: launch.uid, gid: launch.gid } })
  const served = serveApp(kernel, proc, win, launch)
  win.setContent({ app: launch })
  return { closed: served.closed, dispose: served.dispose }
}

export const hostPresenters: Record<string, Presenter> = {
  external: presentExternal,
  browser: presentBrowser,
  document: presentDocument,
  app: presentApp,
  video: presentMedia('video'),
  audio: presentMedia('audio')
}
