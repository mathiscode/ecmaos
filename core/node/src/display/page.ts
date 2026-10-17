import { frameDocument, relayScript } from '@ecmaos/kernel/lib/display-sandbox'

// `<` is escaped so the document can sit inside the page's own script element
const frame = JSON.stringify(frameDocument).replace(/</g, '\\u003c')

/**
 * The page a host window loads. It holds no kernel: it connects back to the display server with the token in its URL
 * fragment, draws what it is told (a title and content), and reports the user's focus, resizing and closing.
 */
export const displayPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ecmaOS</title>
<style>
  html, body { margin: 0; height: 100%; background: #101010; color: #e8e8e8; font: 14px monospace; }
  #content { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  canvas#pixels { display: block; width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; background: #000; }
  pre#text { margin: 0; padding: 8px; white-space: pre-wrap; word-break: break-word; height: 100%; box-sizing: border-box; overflow: auto; }
  #status[hidden] { display: none; }
  #status { position: fixed; inset: 0; display: grid; place-items: center; opacity: .6; pointer-events: none; }
</style>
</head>
<body>
<div id="status">connecting</div>
<script>
${relayScript}
</script>
<script>
(() => {
  const token = location.hash.slice(1)
  history.replaceState(null, '', location.pathname)
  const status = document.getElementById('status')
  let id = null
  const socket = new WebSocket('ws://' + location.host + '/ws')
  const send = message => { if (socket.readyState === 1) socket.send(JSON.stringify(message)) }
  const frameDocument = ${frame}
  let app = null
  const clear = () => {
    if (app) { app.dispose(); app = null }
    document.querySelectorAll('#content, #text, #pixels').forEach(node => node.remove())
  }

  // What the user does on a framebuffer's canvas goes to the machine (see lib/canvas-input.ts, which this repeats)
  const attachInput = canvas => {
    const emit = input => { if (id !== null) send({ t: 'input', id, input }) }
    canvas.tabIndex = 0
    canvas.style.outline = 'none'
    const position = event => {
      const rect = canvas.getBoundingClientRect()
      const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height) || 1
      const left = rect.left + (rect.width - canvas.width * scale) / 2
      const top = rect.top + (rect.height - canvas.height * scale) / 2
      return { k: 'pointer', x: Math.min(Math.max((event.clientX - left) / scale, 0), canvas.width - 1), y: Math.min(Math.max((event.clientY - top) / scale, 0), canvas.height - 1) }
    }
    const key = down => event => { emit({ k: 'key', code: event.code, down, repeat: event.repeat }); event.preventDefault() }
    const on = (name, listener) => canvas.addEventListener(name, listener)
    on('mouseenter', event => { emit(position(event)); emit({ k: 'enter' }) })
    on('mouseleave', () => emit({ k: 'leave' }))
    on('mousemove', event => emit(position(event)))
    on('mousedown', event => { canvas.focus(); emit(position(event)); emit({ k: 'button', button: event.button, down: true }) })
    on('mouseup', event => emit({ k: 'button', button: event.button, down: false }))
    on('wheel', event => { emit({ k: 'wheel', dx: Math.sign(event.deltaX), dy: -Math.sign(event.deltaY) }); event.preventDefault() })
    on('contextmenu', event => event.preventDefault())
    on('keydown', key(true))
    on('keyup', key(false))
    on('focus', () => emit({ k: 'focus' }))
    on('blur', () => emit({ k: 'blur' }))
    if (window.ResizeObserver) new ResizeObserver(() => { if (canvas.clientWidth > 0 && canvas.clientHeight > 0) emit({ k: 'size', width: Math.round(canvas.clientWidth), height: Math.round(canvas.clientHeight) }) }).observe(canvas)
  }

  // A framebuffer's frame replaces what its canvas shows; the canvas is made once, so frames do not rebuild the page
  const drawPixels = pixels => {
    let canvas = document.getElementById('pixels')
    if (!canvas) {
      clear()
      canvas = document.createElement('canvas')
      canvas.id = 'pixels'
      document.body.append(canvas)
      attachInput(canvas)
    }
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) { canvas.width = pixels.width; canvas.height = pixels.height }
    const context = canvas.getContext('2d')
    const text = atob(pixels.data)
    const image = context.createImageData(pixels.width, pixels.height)
    const target = new Uint32Array(image.data.buffer)
    for (let i = 0; i < target.length; i++) {
      const o = i * 4
      target[i] = 0xff000000 | (text.charCodeAt(o) << 16) | (text.charCodeAt(o + 1) << 8) | text.charCodeAt(o + 2)
    }
    context.putImageData(image, 0, 0)
  }

  const show = content => {
    if (content && content.pixels) { status.hidden = true; return drawPixels(content.pixels) }
    clear()
    status.hidden = true
    if (content && typeof content.text === 'string') {
      const pre = document.createElement('pre')
      pre.id = 'text'
      pre.textContent = content.text
      document.body.append(pre)
    } else if (content && content.app) {
      app = ecmaosMountApp(document.body, content.app, frameDocument, (n, op, args) => send({ t: 'call', id, call: n, op, args }), dirty => {
        // the browser asks before the window closes while the app has unsaved changes
        window.onbeforeunload = dirty ? event => { event.preventDefault(); event.returnValue = '' } : null
      })
    } else if (content && (typeof content.html === 'string' || typeof content.url === 'string')) {
      const frame = document.createElement('iframe')
      frame.id = 'content'
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
      if (typeof content.html === 'string') frame.srcdoc = content.html
      else frame.src = content.url
      document.body.append(frame)
    }
  }

  const geometry = () => ({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight })
  let last = ''
  const report = () => {
    if (id === null) return
    const now = geometry()
    const key = JSON.stringify(now)
    if (key === last) return
    last = key
    send({ t: 'changed', id, geometry: now })
  }

  socket.onopen = () => send({ t: 'hello', token })
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.t === 'open') {
      id = message.id
      document.title = message.title
      last = JSON.stringify(geometry())
      if (message.content) show(message.content)
      else status.textContent = ''
    } else if (message.t === 'update') {
      document.title = message.title
      if (message.state === 'fullscreen' && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {})
      else if (message.state !== 'fullscreen' && document.fullscreenElement) document.exitFullscreen().catch(() => {})
      // a page can move or size only its own popups; the browser may refuse, and the operating system's window manager owns the rest
      try { window.resizeTo(message.geometry.width, message.geometry.height) } catch {}
    } else if (message.t === 'content') show(message.content)
    else if (message.t === 'result') { if (app) app.result(message.call, message.result, message.error) }
    else if (message.t === 'close') { socket.onclose = null; window.close() }
  }
  socket.onclose = () => { status.hidden = false; status.textContent = 'disconnected'; window.close() }
  window.addEventListener('resize', report)
  window.addEventListener('focus', () => { if (id !== null) send({ t: 'focused', id }) })
  // moving a window raises no event; poll for it
  setInterval(report, 500)
})()
</script>
</body>
</html>
`
