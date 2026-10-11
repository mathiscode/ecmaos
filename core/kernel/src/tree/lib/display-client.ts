/**
 * The tab that is only a display (`?display=N`): an xterm over a remote tty of the machine another tab runs. No kernel, no filesystem
 * and no workers here; see `remote-display.ts` for the protocol.
 */

import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { machineStore, parseMachine } from '#lib/machine.ts'
import { keepDisplay, type DisplaySurface, type KeyMods, type RemoteCall } from '#lib/remote-display.ts'
import { presentClipboardRead, presentClipboardWrite, presentNotify, presentSpeak } from '#lib/presenters/bridge.ts'
import type { Presenter } from '#lib/presenters/index.ts'

/** The address of the display page for tty `tty`, keeping the machine the address names */
export function displayAddress(href: string, tty: number): string {
  const url = new URL(href)
  url.searchParams.set('display', String(tty))
  return url.toString()
}

/** The tty and store a page address asks to display, or `undefined` for a normal boot */
export function displayRequest(search: string): { tty: number, store: string } | { error: string } | undefined {
  const params = new URLSearchParams(search)
  const raw = params.get('display')
  if (raw === null) return undefined
  const tty = /^[0-7]$/.test(raw) ? Number(raw) : -1
  if (tty < 0) return { error: `'${raw.slice(0, 20)}' is not a tty (0 to 7)` }
  const machine = parseMachine(params.get('machine'))
  if (machine.error) return { error: machine.error }
  return { tty, store: machineStore(machine.machine) }
}

function say(text: string) {
  const note = document.createElement('p')
  note.style.cssText = 'color:#e6e6e6;font:15px system-ui,sans-serif;padding:16px'
  note.textContent = text
  document.body.replaceChildren(note)
}

export async function runDisplay(request: { tty: number, store: string } | { error: string }) {
  document.body.style.cssText = 'margin:0;background:#000'
  if ('error' in request) return say(request.error)
  const { tty, store } = request
  document.title = `ecmaOS tty${tty}`

  const host = document.createElement('div')
  host.style.cssText = 'height:100vh;width:100vw'
  document.body.replaceChildren(host)

  const term = new XTerm({ cursorBlink: true, convertEol: true, fontFamily: 'FiraCode Nerd Font Mono, Ubuntu Mono, courier-new, courier, monospace' })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)

  // Each attach hands over fresh senders (a reconnect is a new session); the xterm and window listeners are made once
  let sendData: (text: string) => void = () => {}
  let sendKey: (key: string, mods: KeyMods) => void = () => {}
  let sendSize: (cols: number, rows: number) => void = () => {}
  term.onData(data => sendData(data))
  term.onKey(({ key: text, domEvent }) => sendKey(text, { key: domEvent.key, ctrl: domEvent.ctrlKey, alt: domEvent.altKey, shift: domEvent.shiftKey, meta: domEvent.metaKey }))
  const refit = () => { fit.fit(); sendSize(term.cols, term.rows) }
  globalThis.addEventListener('resize', refit)

  const surface: DisplaySurface = {
    open: (cols, rows, screen) => { term.reset(); term.resize(cols, rows); term.write(screen); term.focus() },
    write: data => term.write(data),
    onInput: (data, key) => { sendData = data; sendKey = key },
    onResize: size => { sendSize = size; refit() },
    lost: reason => term.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`)
  }

  // Calls that only work in the page the user is at: this one, since this is where they type
  const remote: Record<string, Presenter> = { notify: presentNotify, 'clipboard-write': presentClipboardWrite, 'clipboard-read': presentClipboardRead, speak: presentSpeak }
  const present = (kind: string, params: Record<string, unknown>): RemoteCall => {
    const presenter = remote[kind]
    if (!presenter) throw new Error(`this display cannot do ${kind}`)
    const started = Promise.resolve(presenter(undefined as never, undefined as never, params))
    let dispose: (() => void) | undefined
    const done = started.then(async presented => {
      dispose = presented?.dispose
      if (presented?.closed) return presented.closed
      return presented?.result ?? null
    })
    return { done, cancel: () => dispose?.() }
  }

  keepDisplay(store, tty, surface, { locks: globalThis.navigator?.locks, present })
  document.title = `ecmaOS tty${tty}`
}
