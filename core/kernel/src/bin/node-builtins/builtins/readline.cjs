/**
 * Node's `readline`. The terminal already edits a line and echoes it (canonical mode), so an interface reads whole lines
 * from its input; `terminal: true` changes nothing about that, and the keys of a raw-mode editor are not emitted.
 */

const { EventEmitter } = require('node:events')

class Interface extends EventEmitter {
  constructor(input, output, completer, terminal) {
    super()
    const options = input && typeof input === 'object' && !input.on ? input : { input, output, completer, terminal }
    this.input = options.input
    this.output = options.output
    this.terminal = Boolean(options.terminal ?? options.output?.isTTY)
    this.line = ''
    this.closed = false
    this.history = []
    this._prompt = options.prompt ?? '> '
    this._buffer = ''
    this._questions = []
    this._paused = false
    this._queue = []
    this._wanted = []
    this._onData = chunk => this._data(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    this._onEnd = () => { if (this._buffer) { const rest = this._buffer; this._buffer = ''; this._line(rest) } this.close() }
    this.input?.on('data', this._onData)
    this.input?.on('end', this._onEnd)
    this.input?.resume?.()
  }

  _data(text) {
    this._buffer += text
    for (let at = this._buffer.search(/\r\n|\n|\r/); at >= 0; at = this._buffer.search(/\r\n|\n|\r/)) {
      const line = this._buffer.slice(0, at)
      this._buffer = this._buffer.slice(this._buffer[at] === '\r' && this._buffer[at + 1] === '\n' ? at + 2 : at + 1)
      this._line(line)
    }
  }

  _line(line) {
    const question = this._questions.shift()
    if (question) { question(line); return }
    this.emit('line', line)
  }

  setPrompt(prompt) { this._prompt = String(prompt) }
  getPrompt() { return this._prompt }
  prompt() { this.output?.write(this._prompt) }
  write(data) { if (typeof data === 'string') this._data(data) }

  question(query, options, callback) {
    if (typeof options === 'function') callback = options
    if (this.closed) throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' })
    this.output?.write(String(query))
    this._questions.push(callback)
  }

  pause() { this.input?.pause?.(); this.emit('pause'); return this }
  resume() { this.input?.resume?.(); this.emit('resume'); return this }

  close() {
    if (this.closed) return
    this.closed = true
    this.input?.off('data', this._onData)
    this.input?.off('end', this._onEnd)
    this.input?.pause?.()
    this.emit('close')
  }

  getCursorPos() { return { rows: 0, cols: this.line.length } }

  [Symbol.asyncIterator]() {
    const lines = []
    const waiting = []
    let ended = false
    this.on('line', line => { const wake = waiting.shift(); if (wake) wake({ value: line, done: false }); else lines.push(line) })
    this.on('close', () => { ended = true; for (const wake of waiting.splice(0)) wake({ value: undefined, done: true }) })
    return {
      next: () => (lines.length ? Promise.resolve({ value: lines.shift(), done: false }) : ended ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => waiting.push(resolve))),
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }) },
      [Symbol.asyncIterator]() { return this }
    }
  }
}

const createInterface = (input, output, completer, terminal) => new Interface(input, output, completer, terminal)

const csi = code => `\u001b[${code}`
const write = (stream, text, callback) => { stream?.write(text); if (callback) queueMicrotask(callback); return true }

module.exports = {
  Interface,
  createInterface,
  clearLine: (stream, dir, callback) => write(stream, csi(dir < 0 ? '1K' : dir > 0 ? '0K' : '2K'), callback),
  clearScreenDown: (stream, callback) => write(stream, csi('0J'), callback),
  cursorTo: (stream, x, y, callback) => { if (typeof y === 'function') { callback = y; y = undefined } return write(stream, y === undefined ? csi(`${x + 1}G`) : csi(`${y + 1};${x + 1}H`), callback) },
  moveCursor: (stream, dx, dy, callback) => write(stream, (dx < 0 ? csi(`${-dx}D`) : dx > 0 ? csi(`${dx}C`) : '') + (dy < 0 ? csi(`${-dy}A`) : dy > 0 ? csi(`${dy}B`) : ''), callback),
  emitKeypressEvents: () => {}
}
// `readline/promises` extends `Interface`, so it is loaded when asked for, not while this module is being made
Object.defineProperty(module.exports, 'promises', { enumerable: true, get: () => require('node:readline/promises') })
