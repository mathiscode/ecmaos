// Runs in the display page. Mounts an app window's sandboxed frame and carries calls between the frame and the machine.
// `send(call, op, args)` forwards a call to the machine; the machine's answer comes back through `result`.
globalThis.ecmaosMountApp = (parent, launch, frameDocument, send) => {
  const frame = document.createElement('iframe')
  frame.id = 'content'
  // an app draws its own background; the page's white default for a frame would show around it
  frame.style.background = 'transparent'
  // No `allow-same-origin`: the app gets an opaque origin, and so no access to this page or anything stored for it
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals allow-downloads')
  frame.srcdoc = frameDocument
  const onMessage = event => {
    if (event.source !== frame.contentWindow) return
    const message = event.data
    if (!message || typeof message !== 'object') return
    if (message.type === 'ready') frame.contentWindow.postMessage({ type: 'boot', launch }, '*')
    else if (message.type === 'call' && typeof message.n === 'number' && typeof message.op === 'string' && Array.isArray(message.args)) send(message.n, message.op, message.args)
  }
  window.addEventListener('message', onMessage)
  parent.append(frame)
  return {
    result(n, result, error) { frame.contentWindow && frame.contentWindow.postMessage({ type: 'result', n, result, error }, '*') },
    dispose() {
      try { frame.contentWindow && frame.contentWindow.postMessage({ type: 'dispose' }, '*') } catch (error) { void error }
      window.removeEventListener('message', onMessage)
      frame.remove()
    }
  }
}
