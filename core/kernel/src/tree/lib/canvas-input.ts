/**
 * Reports what the user does on a canvas that shows a pixel window (a framebuffer) as `WindowInput`, with positions in the
 * canvas's own pixels. The canvas is shown with `object-fit: contain`, so the picture can be smaller than the element and
 * a position outside it is clamped to its edge. Returns the function that removes the listeners.
 */
import type { WindowInput } from '@ecmaos/types'

export function attachCanvasInput(canvas: HTMLCanvasElement, emit: (input: WindowInput) => void): () => void {
  canvas.tabIndex = 0
  canvas.style.outline = 'none'

  const position = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect()
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height) || 1
    const left = rect.left + (rect.width - canvas.width * scale) / 2
    const top = rect.top + (rect.height - canvas.height * scale) / 2
    const x = Math.min(Math.max((event.clientX - left) / scale, 0), canvas.width - 1)
    const y = Math.min(Math.max((event.clientY - top) / scale, 0), canvas.height - 1)
    return { k: 'pointer', x, y } as const
  }
  // Reading the clipboard needs a gesture: the modifier of a paste is the earliest one, so the text is ready by the time V goes down
  let lastClip: string | undefined
  const fetchClipboard = () => {
    try {
      void (globalThis as { navigator?: Navigator }).navigator?.clipboard?.readText().then(text => {
        if (typeof text === 'string' && text && text !== lastClip) { lastClip = text; emit({ k: 'paste', text }) }
      }).catch(() => {})
    } catch { /* no clipboard here */ }
  }
  const key = (down: boolean) => (event: Event) => {
    const { code, repeat } = event as KeyboardEvent
    if (down && !repeat && /^(Control|Meta)(Left|Right)$/.test(code)) fetchClipboard()
    emit({ k: 'key', code, down, repeat })
    event.preventDefault()
  }
  const listeners: [string, (event: Event) => void][] = [
    ['mouseenter', event => { emit(position(event as MouseEvent)); emit({ k: 'enter' }) }],
    ['mouseleave', () => emit({ k: 'leave' })],
    ['mousemove', event => emit(position(event as MouseEvent))],
    ['mousedown', event => { canvas.focus(); emit(position(event as MouseEvent)); emit({ k: 'button', button: (event as MouseEvent).button, down: true }) }],
    ['mouseup', event => emit({ k: 'button', button: (event as MouseEvent).button, down: false })],
    ['wheel', event => {
      const { deltaX, deltaY } = event as WheelEvent
      emit({ k: 'wheel', dx: Math.sign(deltaX), dy: -Math.sign(deltaY) })
      event.preventDefault()
    }],
    ['contextmenu', event => event.preventDefault()],
    ['paste', event => {
      const text = (event as ClipboardEvent).clipboardData?.getData('text/plain')
      if (text) { lastClip = text; emit({ k: 'paste', text }) }
      event.preventDefault()
    }],
    ['dragover', event => { event.preventDefault(); const transfer = (event as DragEvent).dataTransfer; if (transfer) transfer.dropEffect = 'copy' }],
    ['drop', event => {
      event.preventDefault()
      const transfer = (event as DragEvent).dataTransfer
      const where = position(event as MouseEvent)
      const uris = transfer?.getData('text/uri-list')
      const text = uris || transfer?.getData('text/plain')
      if (text) emit({ k: 'drop', x: where.x, y: where.y, text, uris: !!uris })
    }],
    ['keydown', key(true)],
    ['keyup', key(false)],
    ['focus', () => emit({ k: 'focus' })],
    ['blur', () => emit({ k: 'blur' })]
  ]
  for (const [name, listener] of listeners) canvas.addEventListener(name, listener)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const width = Math.round(canvas.clientWidth), height = Math.round(canvas.clientHeight)
    if (width > 0 && height > 0) emit({ k: 'size', width, height })
  }) : undefined
  observer?.observe(canvas)
  return () => { observer?.disconnect(); for (const [name, listener] of listeners) canvas.removeEventListener(name, listener) }
}
