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
  pre#text { margin: 0; padding: 8px; white-space: pre-wrap; word-break: break-word; height: 100%; box-sizing: border-box; overflow: auto; }
  #status { position: fixed; inset: 0; display: grid; place-items: center; opacity: .6; }
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
    document.querySelectorAll('#content, #text').forEach(node => node.remove())
  }

  const show = content => {
    clear()
    status.hidden = true
    if (content && typeof content.text === 'string') {
      const pre = document.createElement('pre')
      pre.id = 'text'
      pre.textContent = content.text
      document.body.append(pre)
    } else if (content && content.app) {
      app = ecmaosMountApp(document.body, content.app, frameDocument, (n, op, args) => send({ t: 'call', id, call: n, op, args }))
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
