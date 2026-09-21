/**
 * The worker-side `ProcessEntryParams` an `@ecmaos-apps/*` program receives. Apps used to be handed
 * the live `kernel`/`shell`/`terminal` objects on the main thread; a worker cannot hold those, so
 * each field an app actually uses is rebuilt here over real syscalls: stdio over fds 0/1/2, the
 * terminal over the tty's termios and window size, `shell.context.fs` over the filesystem syscalls,
 * and the few `kernel` capabilities (`name`, `id`, `dom.toast`) over named custom syscalls.
 */

import ansi from 'ansi-escape-sequences'

import { decodeKeys, rawMode, terminalSize, ttyFd } from '../../../../../utils/src/commands-execve/lib/tty.mjs'
import { readBackAndDelete, scratchPath } from './scratch.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const ICANON = 0o2
const ECHO = 0o10
const ISIG = 0o1

/** Maps one decoded key onto the `KeyboardEvent` fields terminal apps read. */
function keyEvent(key) {
  const code = key.length === 1 ? key.charCodeAt(0) : 0
  let name = key
  let ctrlKey = false

  // The line discipline maps CR to NL (`ICRNL`) even in raw mode
  if (key === '\n' || key === '\r') name = 'Enter'
  else if (key === '\x7f') name = 'Backspace'
  else if (key === '\t') name = 'Tab'
  else if (code > 0 && code < 27) {
    name = String.fromCharCode(code + 96)
    ctrlKey = true
  }

  return { key, domEvent: { key: name, ctrlKey, shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} } }
}

export function createAppParams({ syscalls, init, command }) {
  const { open, read, write, writeAll, close, getcwd, mkdir, unlink, stat, poll, POLLIN, custom, tcgetattr, tcsetattr } = syscalls
  const tty = ttyFd()

  const writeFd = (fd, data) => writeAll(fd, typeof data === 'string' ? encoder.encode(data) : data)

  const writable = fd => new WritableStream({ write: chunk => writeFd(fd, chunk) })
  // Built on first use: a stream starts pulling as soon as it exists, and a blocking read on a
  // terminal stdin would then hang an app that never reads its input
  let stdinStream
  const stdin = () => (stdinStream ??= new ReadableStream({
    pull(controller) {
      const buffer = new Uint8Array(65536)
      const n = read(0, buffer, -1)
      if (n <= 0) controller.close()
      else controller.enqueue(buffer.slice(0, n))
    }
  }, { highWaterMark: 0 }))

  // Keys: raw mode on the first onKey, polled in short slices so timers and fetches keep running
  const keyListeners = new Set()
  let restoreMode
  let pumping = false

  // Keys read but not yet delivered. A paste or fast typing arrives as one chunk, and an app that
  // reacts to a key by asking for a whole line (`readline`) must get the rest of the chunk as that line
  const queue = []

  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (keyListeners.size > 0 && tty >= 0) {
        if (queue.length === 0) {
          const [revents] = poll([{ fd: tty, events: POLLIN }], 20)
          if (revents & POLLIN) {
            const buffer = new Uint8Array(1024)
            const n = read(tty, buffer, -1)
            if (n <= 0) break
            queue.push(...decodeKeys(buffer.subarray(0, n)))
          }
        }

        // One key per turn of the event loop, like separate key events: an app that waits for a
        // key with a fresh `onKey` each time needs a chance to re-register before the next one
        const key = queue.shift()
        if (key !== undefined) {
          const event = keyEvent(key)
          for (const listener of [...keyListeners]) listener(event)
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    } finally {
      pumping = false
    }
  }

  const terminal = {
    ansi,
    stdout: writable(1),
    stderr: writable(2),
    get stdin() { return stdin() },
    write: data => writeFd(1, data),
    writeln: (data = '') => writeFd(1, typeof data === 'string' ? data + '\r\n' : data),
    get rows() { return terminalSize(tty).rows },
    get cols() { return terminalSize(tty).cols },
    get columns() { return terminalSize(tty).cols },
    // The shell prints its own prompt once the program exits; the line editor is not ours to toggle
    prompt: () => '',
    listen() {},
    unlisten() {},
    onKey(listener) {
      if (tty < 0) return { dispose() {} }
      restoreMode ??= rawMode(tty)
      keyListeners.add(listener)
      void pump()
      return { dispose: () => { keyListeners.delete(listener) } }
    },
    /** One line in canonical mode (the line discipline echoes and edits it), raw mode restored after. */
    async readline(prompt = '', hide = false) {
      if (prompt) writeFd(1, prompt)
      if (tty < 0) return ''
      const saved = tcgetattr(tty)
      tcsetattr(tty, { lflag: (saved.lflag | ICANON | ISIG | (hide ? 0 : ECHO)) & (hide ? ~ECHO : ~0) })
      try {
        let line = ''
        // Keys that arrived ahead of this call belong to the line (echoed here: the line discipline never saw them as input)
        while (queue.length > 0) {
          const key = queue.shift()
          if (key === 'Enter' || key === '\n') { writeFd(1, '\r\n'); return line }
          if (key.length === 1) { line += key; if (!hide) writeFd(1, key) }
        }
        while (true) {
          const buffer = new Uint8Array(1024)
          const n = read(tty, buffer, -1)
          if (n <= 0) break
          line += decoder.decode(buffer.subarray(0, n))
          if (line.includes('\n')) break
        }
        return line.replace(/\r?\n.*$/s, '')
      } finally {
        tcsetattr(tty, { lflag: saved.lflag })
      }
    }
  }

  const readText = path => {
    const fd = open(path, 0, 0)
    try {
      const chunks = []
      while (true) {
        const buffer = new Uint8Array(65536)
        const n = read(fd, buffer, -1)
        if (n <= 0) break
        chunks.push(buffer.subarray(0, n))
      }
      const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
      let offset = 0
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
      return out
    } finally {
      close(fd)
    }
  }

  const promises = {
    async exists(path) { try { stat(path); return true } catch { return false } },
    async readFile(path, options) {
      const bytes = readText(path)
      const encoding = typeof options === 'string' ? options : options?.encoding
      return encoding ? decoder.decode(bytes) : bytes
    },
    async writeFile(path, data) {
      const fd = open(path, 1 | 0x40 | 0x200, 0o644)
      try { writeAll(fd, typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data)) } finally { close(fd) }
    },
    async mkdir(path, options) {
      if (!options?.recursive) return mkdir(path, 0o777)
      let current = ''
      for (const part of path.split('/').filter(Boolean)) {
        current += '/' + part
        try { mkdir(current, 0o777) } catch (error) { if (error?.code !== 'EEXIST') throw error }
      }
    },
    async unlink(path) { unlink(path) }
  }

  const cwd = getcwd()
  const shell = {
    cwd,
    envObject: init.env,
    credentials: { uid: 0, gid: 0 },
    context: { fs: { promises } }
  }

  const callWithResult = async (name, ...args) => {
    const path = scratchPath('app')
    await custom(name, ...args, path)
    return JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  }

  let info
  const kernelInfo = async () => (info ??= await callWithResult('kernel_info'))

  const toast = kind => async message => { await custom('dom_toast', kind, String(typeof message === 'string' ? message : message?.message ?? '')) }

  const kernel = {
    // fetched once before `main` runs (see `loadKernelInfo`)
    get name() { return info?.name },
    get id() { return info?.id },
    dom: { toast: { success: toast('success'), error: toast('error'), info: toast('info'), warning: toast('warning') } }
  }

  return {
    params: {
      args: init.argv.slice(2),
      command,
      cwd,
      uid: undefined,
      gid: undefined,
      pid: undefined,
      env: init.env,
      get stdin() { return stdin() },
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      terminal,
      shell,
      kernel
    },
    /** Fills in what only the kernel knows (`name`, `id`, and this process's pid/uid/gid) before `main` runs. */
    async load() {
      const loaded = await kernelInfo()
      Object.assign(this.params, { pid: loaded.pid, uid: loaded.uid, gid: loaded.gid })
    }
  }
}
