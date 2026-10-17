// Runs inside the sandboxed frame of an app window. It has no way out but `postMessage` to the display page, which relays
// to the machine. Plain script: it is shipped as text, so it uses no imports and no template literals.
(() => {
  const pending = new Map()
  const disposers = []
  let counter = 0
  let booted = false
  const ChunkSize = 32 * 1024

  const encode = bytes => {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
    return { $bytes: btoa(binary) }
  }
  const decode = value => value && typeof value === 'object' && typeof value.$bytes === 'string'
    ? Uint8Array.from(atob(value.$bytes), char => char.charCodeAt(0))
    : value
  const call = (op, ...args) => new Promise((resolve, reject) => {
    const n = ++counter
    pending.set(n, { resolve, reject })
    parent.postMessage({ type: 'call', n, op, args: args.map(arg => arg instanceof Uint8Array ? encode(arg) : arg) }, '*')
  })
  const bytesOf = data => typeof data === 'string' ? new TextEncoder().encode(data) : data

  const toast = (message, kind) => {
    const note = document.createElement('div')
    note.textContent = String(message)
    const colors = { info: '#2b4a6f', success: '#2b6f3a', error: '#7a2b2b' }
    note.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:8px 14px;border-radius:4px;color:#fff;font:13px sans-serif;background:' + (colors[kind] || colors.info)
    document.body.append(note)
    setTimeout(() => note.remove(), 3000)
  }

  const makeSdk = launch => ({
    command: launch.command, args: launch.args, cwd: launch.cwd, env: launch.env, pid: launch.pid, uid: launch.uid, gid: launch.gid,
    fs: {
      readFile: async (path, encoding) => {
        const data = decode(await call('fs.readFile', path))
        return encoding ? new TextDecoder().decode(data) : data
      },
      writeFile: async (path, data) => {
        const bytes = bytesOf(data)
        await call('fs.writeFile', path, bytes.subarray(0, ChunkSize))
        for (let at = ChunkSize; at < bytes.length; at += ChunkSize) await call('fs.appendFile', path, bytes.subarray(at, at + ChunkSize))
      },
      appendFile: async (path, data) => {
        const bytes = bytesOf(data)
        for (let at = 0; at < bytes.length || at === 0; at += ChunkSize) await call('fs.appendFile', path, bytes.subarray(at, at + ChunkSize))
      },
      mkdir: (path, options) => call('fs.mkdir', path, options || {}),
      readdir: path => call('fs.readdir', path),
      stat: path => call('fs.stat', path),
      access: path => call('fs.access', path),
      unlink: path => call('fs.unlink', path),
      rename: (from, to) => call('fs.rename', from, to)
    },
    window: {
      setTitle: title => call('window.setTitle', String(title)),
      close: () => call('window.close')
    },
    toast,
    log: message => { void call('log', String(message)) },
    exit: code => call('exit', code | 0),
    onDispose: callback => { disposers.push(callback) }
  })

  const run = async launch => {
    const sdk = makeSdk(launch)
    try {
      const url = URL.createObjectURL(new Blob([launch.source], { type: 'text/javascript' }))
      const module = await import(url)
      const main = module.display || (module.default && module.default.display) || module.default
      if (typeof main !== 'function') throw new Error('the app has no display entry')
      await main(sdk)
    } catch (error) {
      await call('fail', error && error.message ? String(error.message) : String(error)).catch(() => {})
    }
  }

  // what goes wrong in the app is told to the machine's log: the frame has no console anyone can see
  addEventListener('error', event => { void call('log', 'error: ' + event.message).catch(() => {}) })
  addEventListener('unhandledrejection', event => { void call('log', 'unhandled rejection: ' + (event.reason && event.reason.message ? event.reason.message : String(event.reason))).catch(() => {}) })

  addEventListener('message', event => {
    if (event.source !== parent) return
    const message = event.data
    if (!message || typeof message !== 'object') return
    if (message.type === 'result') {
      const waiting = pending.get(message.n)
      if (!waiting) return
      pending.delete(message.n)
      if (message.error !== undefined) waiting.reject(new Error(message.error))
      else waiting.resolve(message.result)
    } else if (message.type === 'boot' && !booted) {
      booted = true
      void run(message.launch)
    } else if (message.type === 'dispose') {
      for (const callback of disposers.splice(0)) { try { callback() } catch (error) { void error } }
    }
  })
  parent.postMessage({ type: 'ready' }, '*')
})()
