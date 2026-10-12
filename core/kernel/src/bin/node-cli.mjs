/**
 * The command line of `/bin/node` when run as `node ...`: option parsing, `-e`/`-p`, a script on stdin, and the REPL.
 * It talks to the guest through the syscalls `node.mjs` passes in (`sys`), not the host's stdio. The REPL is
 * `node:repl` over the guest terminal, available only on the Node host.
 */

const SIGWINCH = 28
// `<asm-generic/termbits.h>` local-mode bits, octal as in the header
const ISIG = 0o1
const ICANON = 0o2
const ECHO = 0o10

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const Usage = `Usage: node [options] [script.js] [arguments]
       node [options] -e "script" [arguments]
       node                          start the REPL

Options:
  -e, --eval "script"       evaluate the script
  -p, --print "script"      evaluate the script and print the result
  -i, --interactive         open the REPL after a script or -e
  -, (piped stdin)          read the script from standard input
  --input-type=module       treat -e, -p and standard input as an ES module
  -v, --version             print the version
  -h, --help                print this help
  --                        end of options
`

/**
 * Splits `node`'s arguments. `args` is everything after the program name. Returns what to do and with what:
 * `{ action: 'help' | 'version' | 'file' | 'eval' | 'stdin' | 'repl', ... }`, or `{ error }` for an option that is
 * not
 * understood (`node` exits 9 for that, as Node does).
 */
export function parseArgs(args) {
  const result = { action: undefined, file: undefined, code: undefined, print: false, interactive: false, module: false, rest: [] }
  let i = 0
  const takeValue = (name, inline) => {
    if (inline !== undefined) return inline
    if (i + 1 >= args.length) throw new Error(`${name} requires an argument`)
    return args[++i]
  }

  try {
    for (; i < args.length; i++) {
      const arg = args[i]
      if (arg === '--') { i++; break }
      if (arg === '-') { result.action = 'stdin'; i++; break }
      if (!arg.startsWith('-')) break

      const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
      switch (flag) {
        case '-e': case '--eval': result.code = takeValue(flag, inline); break
        case '-p': case '--print':
          result.print = true
          // `-p` alone takes the script; `-pe` and `-ep` are the same thing spelled together
          result.code = takeValue(flag, inline)
          break
        case '-pe': case '-ep': result.print = true; result.code = takeValue(flag, inline); break
        case '-i': case '--interactive': result.interactive = true; break
        case '-v': case '--version': return { action: 'version' }
        case '-h': case '--help': return { action: 'help' }
        case '--input-type': {
          const type = takeValue(flag, inline)
          if (type !== 'module' && type !== 'commonjs') return { error: `--input-type must be "module" or "commonjs"` }
          result.module = type === 'module'
          break
        }
        default: return { error: `bad option: ${arg}` }
      }
    }
  } catch (error) {
    return { error: error.message }
  }

  const rest = args.slice(i)
  if (result.code !== undefined) { result.action = 'eval'; result.rest = rest; return result }
  if (result.action === 'stdin') { result.rest = rest; return result }
  if (rest.length) { result.action = 'file'; result.file = rest[0]; result.rest = rest.slice(1); return result }
  result.action = 'repl'
  return result
}

/** The one place `console` is pointed at the guest: `log` and friends write to fd 1, `error` and `warn` to fd 2 */
export function installConsole(sys) {
  const util = globalThis.process?.getBuiltinModule?.('node:util')
  const format = util ? (...values) => util.format(...values) : (...values) => values.map(value => {
    if (typeof value === 'string') return value
    try { return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value) } catch { return String(value) }
  }).join(' ')
  const to = fd => (...values) => { sys.writeAll(fd, encoder.encode(format(...values) + '\n')) }
  console.log = console.info = console.debug = to(1)
  console.error = console.warn = to(2)
  return { format, inspect: util ? (value, options) => util.inspect(value, options) : format }
}

/** Reads fd 0 to the end */
export function readStdin(sys) {
  const chunks = []
  for (;;) {
    const buffer = new Uint8Array(65536)
    const n = sys.read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return decoder.decode(bytes)
}

/** Whether `fd` is a terminal: the `TCGETS` ioctl works on it */
export function isTty(sys, fd) {
  try { sys.tcgetattr(fd); return true } catch { return false }
}

/**
 * Runs a script. A module is imported (so `await` works at its top level); a script is evaluated as in a global
 * scope,
 * and with `print` its value is written. A rejected promise or a thrown error is the caller's to report.
 */
export async function runSource(source, { module, print, toDataUrl, inspect, sys }) {
  if (module) {
    await import(toDataUrl(encoder.encode(source)))
    return
  }
  const value = (0, eval)(source)
  if (print) sys.writeAll(1, encoder.encode((typeof value === 'string' ? value : inspect(value)) + '\n'))
  else await value
}

/** `{ rows, cols }`, 24x80 when the terminal cannot say */
function size(sys, fd) {
  try {
    const { row, col } = sys.winsize(fd)
    if (row > 0 && col > 0) return { rows: row, cols: col }
  } catch { /* no size */ }
  return { rows: 24, cols: 80 }
}

/** Where the REPL keeps its history, or undefined when it is turned off (`NODE_REPL_HISTORY=''`) */
function historyPath(env) {
  if (env.NODE_REPL_HISTORY !== undefined) return env.NODE_REPL_HISTORY === '' ? undefined : env.NODE_REPL_HISTORY
  return env.HOME ? `${env.HOME.replace(/\/$/, '')}/.node_repl_history` : undefined
}

const HistoryLines = 1000

/**
 * Node's REPL on the guest terminal. Returns the exit status. The terminal is put in raw mode (no echo, no line
 * buffering, `^C` as a byte so the REPL can cancel the line instead of the kernel killing the program), and given
 * back
 * when the REPL ends; the kernel restores it too if the program dies first.
 */
export async function startRepl(sys, { env }) {
  const builtin = globalThis.process?.getBuiltinModule
  const repl = builtin?.('node:repl')
  const stream = builtin?.('node:stream')
  if (!repl || !stream) {
    sys.writeAll(2, encoder.encode('node: the interactive REPL needs a host with node:repl\n'))
    return 1
  }
  const fd = [0, 2, 1].find(candidate => isTty(sys, candidate))
  if (fd === undefined) {
    sys.writeAll(2, encoder.encode('node: the interactive REPL needs a terminal\n'))
    return 1
  }

  const saved = sys.tcgetattr(fd)
  sys.tcsetattr(fd, { lflag: saved.lflag & ~(ICANON | ECHO | ISIG) })
  const restore = () => { try { sys.tcsetattr(fd, { lflag: saved.lflag }) } catch { /* the terminal is gone */ } }

  let closed = false
  // fd 0 is read with `poll` and a short timeout, not a plain blocking `read`, so timers and promises in the REPL
  // keep running while it waits for a key
  const input = new stream.Readable({
    read() {
      if (this._pumping) return
      this._pumping = true
      const pump = () => {
        if (closed) { this._pumping = false; return }
        try {
          const [events] = sys.poll([{ fd: 0, events: sys.POLLIN }], 25)
          if (events & (sys.POLLIN | sys.POLLHUP)) {
            const buffer = new Uint8Array(4096)
            const n = sys.read(0, buffer, -1)
            this._pumping = false
            if (n <= 0) { this.push(null); return }
            this.push(buffer.subarray(0, n))
            return
          }
        } catch (error) {
          this._pumping = false
          this.destroy(error)
          return
        }
        setTimeout(pump, 0)
      }
      pump()
    }
  })
  input.isTTY = true
  input.setRawMode = () => input

  const output = new stream.Writable({
    write(chunk, _encoding, callback) {
      try { sys.writeAll(1, chunk instanceof Uint8Array ? chunk : encoder.encode(String(chunk))); callback() } catch (error) { callback(error) }
    }
  })
  output.isTTY = true
  output.hasColors = () => true
  output.getColorDepth = () => 8
  const resize = () => { const { rows, cols } = size(sys, fd); output.rows = rows; output.columns = cols }
  resize()
  const onResize = () => { resize(); output.emit('resize') }
  sys.onSignal(SIGWINCH, onResize)

  const version = globalThis.process?.version ?? ''
  output.write(`Welcome to Node.js ${version}.\nType ".help" for more information.\n`)

  const server = repl.start({ prompt: '> ', input, output, terminal: true, useGlobal: true, useColors: true })

  // History lives in the guest's filesystem (Node's own `setupHistory` would write the host's)
  const file = historyPath(env)
  const session = []
  if (file) {
    try {
      const text = decoder.decode(sys.readWholeFile(file))
      server.history = text.split('\n').filter(Boolean).reverse().slice(0, HistoryLines)
    } catch { /* no history yet */ }
    // REPL commands (`.save`, `.exit`) are not part of the session or of its history
    server.on('line', line => { if (line.trim() && !line.trim().startsWith('.')) session.push(line) })
    server.on('exit', () => {
      if (!session.length) return
      try {
        const previous = (() => { try { return decoder.decode(sys.readWholeFile(file)).split('\n').filter(Boolean) } catch { return [] } })()
        const lines = [...previous, ...session].slice(-HistoryLines).join('\n') + '\n'
        const handle = sys.open(file, sys.O_WRONLY | sys.O_CREAT | sys.O_TRUNC, 0o600)
        try { sys.writeAll(handle, encoder.encode(lines)) } finally { sys.close(handle) }
      } catch { /* a history that cannot be saved is not worth failing the session for */ }
    })
  }

  // `.save` and `.load` in Node use the host's fs; these use the guest's
  server.defineCommand('save', {
    help: 'Save all evaluated commands in this REPL session to a file',
    action(target) {
      try {
        const handle = sys.open(target, sys.O_WRONLY | sys.O_CREAT | sys.O_TRUNC, 0o644)
        try { sys.writeAll(handle, encoder.encode(session.join('\n') + '\n')) } finally { sys.close(handle) }
        this.output.write(`Session saved to: ${target}\n`)
      } catch (error) { this.output.write(`Failed to save: ${target} (${error.message})\n`) }
      this.displayPrompt()
    }
  })
  server.defineCommand('load', {
    help: 'Load JS from a file into the REPL session',
    action(target) {
      try {
        const text = decoder.decode(sys.readWholeFile(target))
        for (const line of text.split('\n')) this.write(line + '\n')
      } catch (error) { this.output.write(`Failed to load: ${target} (${error.message})\n`) ; this.displayPrompt() }
    }
  })

  await new Promise(resolve => server.on('exit', resolve))
  closed = true
  sys.offSignal(SIGWINCH, onResize)
  restore()
  return 0
}

export { Usage }
