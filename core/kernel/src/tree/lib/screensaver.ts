/**
 * What the screensavers in `./screensavers/` share: a canvas over the page that takes the terminal's input until the
 * first click, mouse move or key, then gives back what it took. Kept out of `./screensavers/`, where every module is
 * registered as a screensaver.
 */

import type { Terminal } from '@ecmaos/types'

/** A screensaver stops animating after this long and leaves the screen black */
const BLANK_AFTER_MS = 5 * 60_000
/** Frames a second; the screensavers move a fixed step a frame, so a faster display would speed them up */
const FPS = 30

export interface ScreensaverCanvas {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  /** Aborted when the screensaver exits */
  signal: AbortSignal
  /**
   * Calls `draw` on the browser's animation frames, `FPS` times a second, so a hidden tab draws nothing; after
   * `BLANK_AFTER_MS` the canvas is filled black and drawing stops
   */
  animate(draw: () => void): void
}

let active: { controller: AbortController, canvas: HTMLCanvasElement, terminal: Terminal, wasListening: boolean } | undefined

/** Shows a screensaver's canvas, or returns undefined if one is showing already or the canvas cannot draw */
export function openScreensaver(terminal: Terminal, zIndex = Number.MAX_SAFE_INTEGER): ScreensaverCanvas | undefined {
  if (active || document.getElementById('screensaver')) return undefined

  const canvas = document.createElement('canvas')
  canvas.id = 'screensaver'
  canvas.width = globalThis.innerWidth
  canvas.height = globalThis.innerHeight
  canvas.style.position = 'absolute'
  canvas.style.top = '0'
  canvas.style.left = '0'
  canvas.style.zIndex = zIndex.toString()
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  document.body.appendChild(canvas)

  const controller = new AbortController()
  const { signal } = controller
  // the terminal listens again on exit only if it was listening: a program may have its input
  active = { controller, canvas, terminal, wasListening: terminal.listening }
  terminal.unlisten()
  for (const event of ['click', 'mousemove', 'keydown']) document.addEventListener(event, () => exitScreensaver(), { signal })

  const animate = (draw: () => void) => {
    const start = performance.now()
    let last = -Infinity
    const frame = (now: number) => {
      if (signal.aborted) return
      if (now - start >= BLANK_AFTER_MS) {
        ctx.fillStyle = 'black'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        return
      }
      // a frame early by a little still counts, or a 60Hz display would draw at 20 frames a second
      if (now - last >= 1000 / FPS - 2) {
        last = now
        draw()
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  return { canvas, ctx, signal, animate }
}

/** Removes the screensaver showing, if any, and gives the terminal its input back if it took it */
export async function exitScreensaver() {
  if (!active) return
  const { controller, canvas, terminal, wasListening } = active
  active = undefined
  controller.abort()
  canvas.remove()
  if (wasListening) terminal.listen()
}
