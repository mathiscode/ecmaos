/**
 * `ecmash`: the ecmaOS shell as a real program. It runs in a worker like every other command, on the
 * same parsers and expander the kernel-integrated shell uses (`../lib/*`), and reaches the system
 * only through syscalls: `spawn`/`waitpid`/`killpg` for processes, `pipe` for pipelines, `open` for
 * redirections, and the terminal ioctls for its line editor.
 *
 *   ecmash [-l] [-c COMMAND [NAME [ARG...]]] [FILE [ARG...]]
 *
 * With no command and no file it reads commands from stdin; when that is a terminal it is
 * interactive: a prompt, line editing, history in `~/.ecmash_history`, and a SIGINT that cancels the
 * line instead of ending the shell.
 *
 * Covered: simple commands, pipelines, `&&`/`||`/`;`/`&`, redirections (`<`, `>`, `>>`, `2>`, `2>&1`,
 * heredocs, here-strings), `$var`/`${...}`/`$(...)`/`$((...))`, globbing, `if`/`while`/`for`/`case`,
 * `{ }` groups, `( )` subshells (a snapshot, see `runSubshell`), indexed arrays, `<(cmd)`/`>(cmd)`,
 * aliases, `trap`, `set -e` and friends, job control (`^Z`, `fg`, `bg`), functions, and the builtins
 * listed in BUILTINS.
 *
 * Output redirected to a file goes through a scratch file and is copied over when the command ends.
 * The root filesystem corrupts a file written in several chunks through a plain descriptor (see
 * `lib/append-file.ts` in the kernel), and only a whole-file write is safe there.
 */

import { parseStatements, needsMoreInput } from '../lib/control-flow-parser.ts'
import { parseScript, parseRedirections, tokenize, tokenizeConditional } from '../lib/shell-parser.ts'
import { expandWordFieldsBraced, expandWordString, expandHeredocBody, globToRegExpSource } from '../lib/word-expansion.ts'
import { evaluateArithmeticExpression } from '../lib/expand-variables.ts'
import { evaluateConditional } from '../lib/conditional-eval.ts'
import { LineEditor, stripMarkers, visibleWidth } from '../lib/line-editor.ts'
import { History } from '../lib/history.ts'
import { ShellState } from '../lib/shell-core/state.ts'
import { Interpreter } from '../lib/shell-core/interpreter.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from '../lib/shell-core/signals.ts'
import { completionMatches } from '../lib/completion.ts'
import { rawMode, decodeKeys, ttyFd, isTty, terminalSize } from './lib/tty.mjs'

const sys = globalThis.ecmaosSyscalls
const { open, close, read, write, pipe, stat, unlink, readdir, getcwd, chdir, exit, spawn, waitpid, killpg, setpgid, tcsetpgrp, getpid, getppid, onSignal } = sys
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = sys

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const SIGINT = 2
const SIGTSTP = 20
const SIGCONT = 18
// Signals `trap` can name, and the number `onSignal` wants for each.
const TRAP_SIGNALS = { HUP: 1, INT: 2, QUIT: 3, USR1: 10, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, CHLD: 17 }

// -- small fs helpers -----------------------------------------------------------------------------

function readFileText(path) {
  const fd = open(path, O_RDONLY, 0)
  try { return readFd(fd) } finally { close(fd) }
}

function readFd(fd) {
  const chunks = []
  const buffer = new Uint8Array(65536)
  for (;;) {
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.slice(0, n))
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return decoder.decode(bytes)
}

function writeAllFd(fd, text) {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text
  let offset = 0
  while (offset < bytes.length) {
    const n = write(fd, bytes.subarray(offset))
    if (n <= 0) break
    offset += n
  }
}

function writeWholeFile(path, text) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try { writeAllFd(fd, text) } finally { close(fd) }
}

const exists = path => { try { stat(path); return true } catch { return false } }
const isDir = path => { try { return (stat(path).mode & 0xf000) === 0x4000 } catch { return false } }
const isFile = path => { try { return (stat(path).mode & 0xf000) === 0x8000 } catch { return false } }
const resolvePath = (path, cwd = getcwd()) => normalize(path.startsWith('/') ? path : `${cwd}/${path}`)

/** The `)` closing the `(` at `start`, skipping quotes and nested parentheses; -1 when there is none. */
function closingParen(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') { i++; continue }
    if (char === "'") { const end = text.indexOf("'", i + 1); if (end === -1) return -1; i = end; continue }
    if (char === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1; if (j >= text.length) return -1; i = j; continue }
    if (char === '(') depth++
    else if (char === ')' && --depth === 0) return i
  }
  return -1
}

function normalize(path) {
  const out = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// -- shell state ----------------------------------------------------------------------------------

/** A `break`, `continue`, `return` or `exit` unwinding: not an error to report. */
const isUnwind = error => error instanceof BreakSignal || error instanceof ContinueSignal || error instanceof ReturnSignal || error instanceof ExitSignal

const BUILTINS = new Set([
  ':', 'true', 'false', 'cd', 'exit', 'export', 'unset', 'set', 'shift', 'read', 'echo', 'source', '.', 'eval',
  'return', 'break', 'continue', 'local', 'alias', 'unalias', 'trap', 'type', 'command', 'wait', 'jobs', 'fg', 'bg', 'disown', 'test', '[', 'exec', 'pwd', 'env', 'declare', 'readonly',
])

class Shell {
  constructor(name, args) {
    // What the process was started with is inherited by its children; what the shell assigns is not, until `export`.
    this.state = new ShellState({ pid: getpid, ppid: getppid }, new Map(Object.entries(sys.env)))
    this.positional = args
    this.name = name
    this.status = 0
    this.jobs = []
    this.scratch = 0
    this.depth = 0
    this.interactive = false
    this.leaving = false
    this.procsubs = []
    this.procsubCount = 0
    this.pending = []
    this.interpreter = new Interpreter(this.hostInterface(), this.state, { maxFunctionDepth: 200 })
    // Written straight into the store, so they count as inherited: a child shell nests one deeper, and PWD is exported.
    this.vars.set('SHLVL', String((Number(this.vars.get('SHLVL')) || 0) + 1))
    if (!this.vars.has('PWD')) this.vars.set('PWD', getcwd())
    if (!this.vars.has('IFS')) this.state.set('IFS', ' \t\n')
  }

  // Views onto the shared state, so the rest of this class reads as it always did.
  get vars() { return this.state.vars }
  get functions() { return this.state.functions }
  get aliases() { return this.state.aliases }
  get traps() { return this.state.traps }
  get opts() { return this.state.options }
  get lastPid() { return this.state.lastBackgroundPid }
  set lastPid(pid) { this.state.lastBackgroundPid = pid }

  // Descriptors a command runs with, by fd number in *this* process.
  get stdio() { return this._stdio ?? { 0: 0, 1: 1, 2: 2 } }

  get(name) {
    switch (name) {
      case '?': return String(this.status)
      case '#': return String(this.positional.length)
      case '0': return this.name
      case '*': case '@': return this.positional.join(' ')
    }
    if (/^\d+$/.test(name)) return this.positional[Number(name) - 1]
    return this.state.lookup(name)
  }

  /**
   * Assigns a variable. A readonly name fails the assignment: the error is printed, and a script ends
   * there (as bash does when not interactive) while an interactive shell carries on.
   */
  set(name, value) {
    try {
      this.state.set(name, value)
      return true
    } catch (error) {
      writeAllFd(2, `ecmash: ${error.message}\n`)
      this.failedAssignment = true
      return false
    }
  }

  environment() { return this.state.environment() }

  // -- expansion ----------------------------------------------------------------------------------

  context() {
    return {
      lookup: name => this.get(name),
      lookupArray: name => this.state.lookupArray(name),
      positional: () => this.positional,
      assign: (name, value) => this.set(name, value),
      substitute: command => this.substitute(command),
      processSubstitute: (direction, command) => this.processSubstitute(direction, command),
      glob: pattern => this.glob(pattern),
      home: () => this.vars.get('HOME'),
      nounset: this.opts.nounset,
    }
  }

  async fields(parts) { return await expandWordFieldsBraced(parts, this.context()) }
  async text(parts) { return await expandWordString(parts, this.context()) }

  /** Expands a raw word of text (a `case` subject, a `for` list) into fields. */
  async expandWords(text) {
    const fields = []
    for (const token of tokenize(text)) {
      if (token.kind === 'word') fields.push(...await this.fields(token.parts))
    }
    return fields
  }

  /** `$(...)`: runs the command with stdout on a scratch file, so any amount of output is safe. */
  async substitute(command) {
    const file = this.scratchPath()
    const fd = open(file, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    const saved = this._stdio
    this._stdio = { ...this.stdio, 1: fd }
    try {
      await this.runText(command)
    } finally {
      this._stdio = saved
      close(fd)
    }
    const text = readFileText(file)
    try { unlink(file) } catch { /* already gone */ }
    return text.replace(/\n+$/, '')
  }

  scratchPath() { return `/tmp/.ecmash-${getpid()}-${this.scratch++}` }

  /**
   * `<(cmd)` and `>(cmd)` as a temporary file standing in for the far end of a pipe: a child gets
   * only descriptors 0 to 2, so `/dev/fd/N` would name nothing in it. `<(cmd)` runs to completion
   * into the file first; `>(cmd)` runs afterwards with the file as its stdin. Removed by
   * `finishProcSubs` once the pipeline that used it is done. It does not stream.
   */
  async processSubstitute(direction, command) {
    const path = `/tmp/.ecmash-procsub-${getpid()}-${this.procsubCount++}`
    writeWholeFile(path, '')
    if (direction === '<') {
      const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
      const saved = this._stdio
      this._stdio = { ...this.stdio, 1: fd }
      try { await this.runSubshell(parseStatements(command)) } finally { this._stdio = saved; close(fd) }
      this.procsubs.push({ path })
    } else {
      this.procsubs.push({ path, after: async () => {
        const fd = open(path, O_RDONLY)
        const saved = this._stdio
        this._stdio = { ...this.stdio, 0: fd }
        try { await this.runSubshell(parseStatements(command)) } finally { this._stdio = saved; close(fd) }
      } })
    }
    return path
  }

  async finishProcSubs(mark) {
    for (const { path, after } of this.procsubs.splice(mark)) {
      try { await after?.() } finally { try { unlink(path) } catch { /* already gone */ } }
    }
  }

  // -- arrays -------------------------------------------------------------------------------------

  /**
   * `a=(x y)`, `a+=(z)` and `a[i]=v` at the start of a line. Returns the status, or `undefined` when
   * the line is not one. The parser splits `a=(x y)` into two words, which is why this reads the raw
   * text instead of the tokens.
   */
  async arrayAssignment(line) {
    const head = /^(?:(?:declare|typeset|local|readonly)\s+(?:-[A-Za-z]+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)(\+?)=\(/.exec(line)
    const close = head ? closingParen(line, head[0].length - 1) : -1
    const tail = close === -1 ? undefined : /^\s*(?:(;|&&|\|\|)\s*([\s\S]*))?$/.exec(line.slice(close + 1))
    if (head && tail) {
      const [, name, append] = head
      const body = line.slice(head[0].length, close)
      const [, operator, rest] = tail
      const values = []
      for (const token of body.trim() ? tokenize(body) : []) if (token.kind === 'word') values.push(...await this.fields(token.parts))
      if (append) this.state.appendArray(name, values); else this.state.setArray(name, values)
      return await this.afterAssignment(operator, rest)
    }
    const element = /^(?:(?:declare|typeset|local|readonly)\s+(?:-[A-Za-z]+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]=(\S*)\s*(?:(;|&&|\|\|)\s*([\s\S]*))?$/.exec(line)
    if (element) {
      const [, name, subscript, raw, operator, rest] = element
      const index = evaluateArithmeticExpression(subscript, variable => this.get(variable))
      this.state.setArrayElement(name, index, await this.text((tokenize(raw || "''")[0] ?? { parts: [] }).parts))
      return await this.afterAssignment(operator, rest)
    }
    return undefined
  }

  async afterAssignment(operator, rest) {
    if (!rest) return 0
    if (operator === '||') return 0
    return await this.runLine(rest)
  }

  async glob(pattern) {
    if (!/[*?[]/.test(pattern)) return []
    const absolute = pattern.startsWith('/')
    const segments = pattern.split('/').filter(Boolean)
    let bases = [absolute ? '/' : '']
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1
      const next = []
      for (const base of bases) {
        const dir = base === '' ? '.' : base
        if (!/[*?[]/.test(segment)) {
          const candidate = base === '' ? segment : base === '/' ? `/${segment}` : `${base}/${segment}`
          if (exists(resolvePath(candidate))) next.push(candidate)
          continue
        }
        let names
        try { names = readdir(resolvePath(dir)) } catch { continue }
        const regex = new RegExp(`^${globToRegExpSource(segment)}$`)
        for (const name of names.sort()) {
          if (name.startsWith('.') && !segment.startsWith('.')) continue
          if (!regex.test(name)) continue
          const candidate = base === '' ? name : base === '/' ? `/${name}` : `${base}/${name}`
          if (last || isDir(resolvePath(candidate))) next.push(candidate)
        }
      }
      bases = next
    }
    return bases
  }

  // -- running text -------------------------------------------------------------------------------

  async runText(text) { return await this.interpreter.runText(text) }
  async runStatements(statements) { return await this.interpreter.runStatements(statements) }
  async runSubshell(statements) { return await this.interpreter.runSubshell(statements) }
  async runLine(line) { return await this.interpreter.runLine(line) }
  async callFunction(name, args) { return await this.interpreter.callFunction(name, args) }

  /** What the shared interpreter needs from this shell: how to run a pipeline, and the per-process pieces of state. */
  hostInterface() {
    const shell = this
    return {
      runPipeline: async pipeline => [await shell.runPipeline(pipeline)],
      runBackground: pipeline => shell.runBackground(pipeline),
      runSpecial: line => shell.arrayAssignment(line),
      withRedirect: (statement, run) => shell.withRedirect(statement, run),
      expandWords: text => shell.expandWords(text),
      caseSubject: async word => (await shell.expandWords(word))[0] ?? '',
      matchesPattern: (subject, pattern) => new RegExp(`^${globToRegExpSource(pattern.replace(/^["']|["']$/g, ''))}$`).test(subject),
      assign: (name, value) => { shell.set(name, value) },
      enterParameters: args => {
        const saved = shell.positional
        shell.positional = args
        return () => { shell.positional = saved }
      },
      // There is no fork, so a subshell is a snapshot: variables, arrays, functions, aliases, the
      // positional parameters and the working directory are put back afterwards.
      snapshot: () => {
        const saved = shell.state.snapshot()
        const outside = { positional: shell.positional, cwd: getcwd(), leaving: shell.leaving }
        return () => {
          shell.state.restore(saved)
          shell.positional = outside.positional
          shell.leaving = outside.leaving
          if (getcwd() !== outside.cwd) chdir(outside.cwd)
        }
      },
      getStatus: () => shell.status,
      setStatus: code => { shell.status = code },
      checkpoint: async () => { await shell.runPendingTraps(); return false },
      exitShell: code => shell.leave(code),
      writeErr: message => { writeAllFd(2, `ecmash: ${message}\n`) },
    }
  }

  /** A compound statement's trailing redirection, held over its whole body. */
  async withRedirect(statement, run) {
    if (!statement.redirect) return await run()
    const saved = this._stdio
    const mark = this.procsubs.length
    const applied = await this.openRedirections(parseRedirections(statement.redirect), { ...this.stdio })
    this._stdio = applied.fds
    try { return await run() } finally {
      this._stdio = saved
      await applied.finish()
      await this.finishProcSubs(mark)
    }
  }

  /** Runs the `EXIT` trap once, then ends the shell. */
  async leave(code) {
    if (this.interpreter.subshellDepth) throw new ExitSignal(code & 0xff)
    if (!this.leaving) {
      this.leaving = true
      const trap = this.traps.get('EXIT')
      if (trap) { try { await this.runText(trap) } catch { /* the shell is going anyway */ } }
    }
    exit(code & 0xff)
  }

  /**
   * Signals that arrived while this worker sat in an async syscall never reach their handler (the next
   * blocking syscall clears them first), but they are still visible on the thread's page until then.
   */
  collectSignals() {
    const mask = sys.pendingSignals?.() ?? 0
    if (!mask) { this.seenMask = 0; return }
    const fresh = mask & ~(this.seenMask ?? 0)
    this.seenMask = mask
    for (const [name, number] of Object.entries(TRAP_SIGNALS)) {
      if ((fresh & (1 << number)) && this.traps.has(name) && !this.pending.includes(name)) this.pending.push(name)
    }
  }

  /** Runs the traps for signals that arrived since the last look: between commands, as in bash. */
  async runPendingTraps() {
    this.collectSignals()
    while (this.pending.length) {
      const text = this.traps.get(this.pending.shift())
      if (!text) continue
      const status = this.status
      await this.runText(text)
      this.status = status
    }
  }

  // -- pipelines ----------------------------------------------------------------------------------

  /** A job-table entry for a started pipeline. Numbers are never reused while an entry is alive. */
  addJob(handle, pipeline, extra = {}) {
    const number = Math.max(0, ...this.jobs.map(job => job.number)) + 1
    const line = pipeline.commands.map(command => command.words.join(' ')).join(' | ')
    const record = { number, handle, pids: handle.pids, pgid: handle.leader, line, finished: false, code: 0, reported: false, stopped: false, ...extra }
    this.jobs.push(record)
    return record
  }

  /** Waits for a background job in the background, recording how it ended. */
  watch(record, untraced = false) {
    record.done = record.handle.finish({ untraced }).then(status => {
      if (record.handle.stopped) { record.stopped = true; return }
      record.finished = true
      record.code = status
    })
  }

  async runBackground(pipeline) {
    const mark = this.procsubs.length
    const job = await this.startPipeline(pipeline, true)
    if (!job) return 1
    const record = this.addJob(job, pipeline, { background: true })
    this.watch(record)
    record.done = record.done.then(() => this.finishProcSubs(mark))
    this.lastPid = job.pids[job.pids.length - 1]
    if (this.interactive) writeAllFd(2, `[${record.number}] ${this.lastPid}\n`)
    return 0
  }

  async runPipeline(pipeline) {
    const mark = this.procsubs.length
    const job = await this.startPipeline(pipeline, false)
    if (!job) { await this.finishProcSubs(mark); return 127 }
    const status = await job.finish({ untraced: this.interactive })
    await this.finishProcSubs(mark)
    if (job.stopped) {
      // ^Z: the job stays in the table, stopped, until `fg` or `bg` resumes it.
      const record = this.addJob(job, pipeline, { stopped: true })
      writeAllFd(1, `\r\n[${record.number}]+  Stopped    ${record.line}\r\n`)
      this.restoreTerminal()
      return 128 + SIGTSTP
    }
    this.restoreTerminal()
    return pipeline.negated ? (status === 0 ? 1 : 0) : status
  }

  /** The terminal goes back to this shell once a foreground job has finished or stopped. */
  restoreTerminal() {
    if (!this.interactive) return
    try { tcsetpgrp(getpid()) } catch { /* no terminal */ }
  }

  /**
   * Spawns every stage of a pipeline, wiring stage N's stdout to stage N+1's stdin with `pipe`.
   * Builtins run in this process, in order, with the same descriptors a program would get.
   * Returns `{ pids, finish() }` or `undefined` when nothing could be started.
   */
  async startPipeline(pipeline, background) {
    const commands = pipeline.commands
    const pids = []
    const cleanups = []
    let inherited = this.stdio[0]
    let leader = 0
    let statusOfBuiltin
    let builtinFailure = 0
    let failed = false

    for (const [index, command] of commands.entries()) {
      const last = index === commands.length - 1
      let next
      const fds = { ...this.stdio, 0: inherited }
      if (!last) {
        next = pipe()
        fds[1] = next[1]
      }

      try {
        const result = await this.runCommand(command, fds, { pgid: leader, background, single: commands.length === 1 })
        if (result.pid !== undefined) {
          pids.push(result.pid)
          if (!leader) leader = result.pid
        } else {
          statusOfBuiltin = result.status
          if (result.status) builtinFailure = result.status
        }
        if (result.finish) cleanups.push(result.finish)
      } catch (error) {
        if (isUnwind(error)) throw error
        writeAllFd(2, `ecmash: ${error?.message ?? error}\n`)
        statusOfBuiltin = error?.code === 'ENOENT' ? 127 : 126
        failed = true
      }

      // The parent's copies of a pipe's ends have to go, or a reader never sees EOF.
      if (inherited !== this.stdio[0]) close(inherited)
      if (next) { close(next[1]); inherited = next[0] }
      if (failed) statusOfBuiltin = statusOfBuiltin ?? 1
    }
    if (inherited !== this.stdio[0]) { try { close(inherited) } catch { /* already closed */ } }

    const reaped = new Map()
    const handle = { pids, leader, stopped: false, finish: null }
    handle.finish = async ({ untraced = false } = {}) => {
      handle.stopped = false
      let interrupted = false
      await Promise.all(pids.filter(pid => !reaped.has(pid)).map(async pid => {
        for (;;) {
          let done
          try { done = await waitpid(pid, false, untraced) } catch (error) {
            // A signal with a trap set interrupts the wait; the trap runs, then the wait resumes.
            if (error?.code === 'EINTR') { await this.runPendingTraps(); continue }
            throw error
          }
          if (done.stopped) {
            handle.stopped = true
            // The terminal stops only its foreground process; the rest of the pipeline is ours to stop.
            if (leader) { try { killpg(leader, SIGTSTP) } catch { /* already stopped */ } }
            return
          }
          reaped.set(pid, done)
          // The terminal signals only its foreground process; the rest of the pipeline is ours to stop.
          if (done.signal === SIGINT && !interrupted && leader) {
            interrupted = true
            try { killpg(leader, SIGINT) } catch { /* everyone already exited */ }
          }
          return
        }
      }))
      await this.runPendingTraps()
      if (handle.stopped) return 128 + SIGTSTP
      let failure = builtinFailure
      let statusOfLast = statusOfBuiltin ?? 0
      for (const pid of pids) {
        const done = reaped.get(pid)
        const code = done.signal ? 128 + done.signal : done.code
        if (code !== 0) failure = code
        if (pid === pids[pids.length - 1]) statusOfLast = code
      }
      const status = this.opts.pipefail && failure !== 0 ? failure : statusOfLast
      // A foreground stage killed by ^C runs the INT trap, as the kernel shell does.
      if (interrupted && this.traps.has('INT')) { try { await this.runText(this.traps.get('INT')) } catch { /* ignore */ } }
      for (const cleanup of cleanups.splice(0)) await cleanup()
      return status
    }
    return handle
  }

  // -- one command --------------------------------------------------------------------------------

  async runCommand(command, fds, options) {
    if (command.conditional !== undefined) {
      const ok = await evaluateConditional(tokenizeConditional(command.conditional), this.context(), {
        exists: async p => exists(resolvePath(p)),
        isFile: async p => isFile(resolvePath(p)),
        isDirectory: async p => isDir(resolvePath(p)),
        resolve: p => resolvePath(p),
      }, () => {})
      return { status: ok ? 0 : 1 }
    }

    const args = []
    let assignments = 0
    let collecting = true
    const assign = []
    for (const [index, parts] of command.wordParts.entries()) {
      const first = parts[0]
      if (collecting && first?.quoting === 'unquoted' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text)) {
        const [, name, rest] = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(first.text)
        const valueParts = [{ ...first, text: rest }, ...parts.slice(1)]
        assign.push([name, await this.text(valueParts)])
        assignments++
        continue
      }
      collecting = false
      args.push(...await this.fields(parts))
    }

    if (!args.length) {
      for (const [name, value] of assign) {
        if (this.set(name, value)) continue
        // A readonly assignment ends a script, as in bash; an interactive shell just reports it.
        if (!this.interactive) await this.leave(1)
        return { status: 1 }
      }
      return { status: 0 }
    }

    // An alias stands in for the command word once (no chains), as in a POSIX shell.
    if (this.aliases.has(args[0])) {
      const expansion = await this.expandWords(this.aliases.get(args[0]))
      args.splice(0, 1, ...expansion)
      if (!args.length) return { status: 0 }
    }
    if (this.opts.xtrace) writeAllFd(2, `+ ${args.join(' ')}\n`)
    const applied = await this.openRedirections(command.redirections, fds)
    const finish = async () => { await applied.finish() }
    const name = args[0]

    if (BUILTINS.has(name) || this.functions.has(name)) {
      // A builtin or function runs here: its assignments are temporary, its descriptors are the ones
      // this command was given.
      const saved = this._stdio
      const snapshot = new Map(assign.map(([n]) => [n, this.vars.get(n)]))
      for (const [n, v] of assign) this.vars.set(n, v)
      this._stdio = applied.fds
      let status
      try {
        status = this.functions.has(name) ? await this.callFunction(name, args.slice(1)) : await this.builtin(name, args.slice(1))
      } finally {
        this._stdio = saved
        for (const [n, v] of snapshot) { if (v === undefined) this.vars.delete(n); else this.vars.set(n, v) }
      }
      await finish()
      return { status }
    }

    const program = this.findProgram(name)
    if (!program) {
      writeAllFd(2, `ecmash: ${name}: command not found\n`)
      await finish()
      return { status: 127 }
    }

    const env = this.environment()
    for (const [n, v] of assign) env[n] = v
    const childFds = {}
    for (const target of [0, 1, 2]) childFds[target] = applied.fds[target] ?? target
    let pid
    try {
      pid = await spawn(program, [name, ...args.slice(1)], { env, fds: childFds, cwd: getcwd(), pgid: options.pgid })
    } finally {
      // The child holds its own references now.
      await applied.release()
    }
    return { pid, finish }
  }

  findProgram(name) {
    if (name.includes('/')) {
      const path = resolvePath(name)
      return isFile(path) ? path : undefined
    }
    for (const dir of (this.vars.get('PATH') ?? '/bin:/usr/bin').split(':')) {
      if (!dir) continue
      const candidate = `${dir}/${name}`
      if (isFile(candidate)) return candidate
    }
    return undefined
  }

  // -- redirections -------------------------------------------------------------------------------

  /**
   * Opens what `redirections` name and returns the descriptor table to run with, `release()` to drop
   * this process's copies once a child has its own, and `finish()` to copy scratch output into its
   * destination file (see the file comment) and close what is left.
   */
  async openRedirections(redirections, base) {
    const fds = { ...base }
    const opened = []
    const copies = []
    const files = new Map()

    for (const redirection of redirections) {
      const fd = redirection.fd
      if (redirection.type === '>&') {
        const target = redirection.targetIsFd ? Number(redirection.target) : undefined
        if (target !== undefined) fds[fd] = fds[target] ?? target
        continue
      }
      if (redirection.type === '<') {
        const path = resolvePath(await this.text(redirection.targetParts ?? [{ text: redirection.target, quoting: 'unquoted' }]))
        const handle = open(path, O_RDONLY, 0)
        opened.push(handle)
        fds[fd] = handle
        continue
      }
      if (redirection.type === '<<' || redirection.type === '<<<') {
        let body
        if (redirection.type === '<<<') body = (await this.text(redirection.targetParts ?? [{ text: redirection.target, quoting: 'unquoted' }])) + '\n'
        else body = redirection.heredoc?.expand ? await expandHeredocBody(redirection.heredoc.body, this.context()) : (redirection.heredoc?.body ?? redirection.target)
        // Small enough to sit in the pipe until the reader takes it.
        const [r, w] = pipe()
        writeAllFd(w, body.length > 60000 ? body.slice(0, 60000) : body)
        close(w)
        opened.push(r)
        fds[fd] = r
        continue
      }
      // > >> >|
      const path = resolvePath(await this.text(redirection.targetParts ?? [{ text: redirection.target, quoting: 'unquoted' }]))
      const direct = path.startsWith('/dev/') || path.startsWith('/tmp/') || path.startsWith('/proc/')
      if (direct) {
        const handle = open(path, O_WRONLY | O_CREAT | (redirection.type === '>>' ? 0 : O_TRUNC), 0o644)
        if (redirection.type === '>>') sys.lseek(handle, 0, 2)
        opened.push(handle)
        fds[fd] = handle
        continue
      }
      let record = files.get(path)
      if (!record) {
        const scratch = this.scratchPath()
        const handle = open(scratch, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        opened.push(handle)
        record = { scratch, handle, path, append: redirection.type === '>>' }
        files.set(path, record)
        copies.push(record)
        // Creating the target now makes `> f` truncate immediately, as in every shell.
        if (!record.append) writeWholeFile(path, '')
        else if (!exists(path)) writeWholeFile(path, '')
      }
      fds[fd] = record.handle
    }

    return {
      fds,
      release: async () => { for (const handle of opened) { try { close(handle) } catch { /* shared */ } } opened.length = 0 },
      finish: async () => {
        for (const handle of opened) { try { close(handle) } catch { /* released already */ } }
        opened.length = 0
        for (const record of copies) {
          const body = readFileText(record.scratch)
          try { unlink(record.scratch) } catch { /* gone */ }
          writeWholeFile(record.path, record.append && exists(record.path) ? readFileText(record.path) + body : body)
        }
        copies.length = 0
      },
    }
  }

  // -- builtins -----------------------------------------------------------------------------------

  out(text, fd = 1) { writeAllFd(this.stdio[fd] ?? fd, text) }

  async builtin(name, args) {
    switch (name) {
      case ':': case 'true': return 0
      case 'false': return 1
      case 'env': {
        if (args.length) { this.out('ecmash: env: running a command with env is not supported\n', 2); return 2 }
        const env = this.environment()
        for (const key of Object.keys(env).sort()) this.out(`${key}=${env[key]}\n`)
        return 0
      }
      case 'pwd': this.out(getcwd() + '\n'); return 0
      case 'echo': {
        let newline = true
        let escapes = false
        while (args[0] && /^-[neE]+$/.test(args[0])) {
          const flags = args.shift()
          if (flags.includes('n')) newline = false
          if (flags.includes('e')) escapes = true
        }
        let text = args.join(' ')
        if (escapes) text = text.replace(/\\(n|t|\\)/g, (_, c) => ({ n: '\n', t: '\t', '\\': '\\' })[c])
        this.out(text + (newline ? '\n' : ''))
        return 0
      }
      case 'cd': {
        const target = args[0] === '-' ? this.vars.get('OLDPWD') : (args[0] ?? this.vars.get('HOME') ?? '/')
        const path = resolvePath(target ?? '/')
        if (!isDir(path)) { this.out(`ecmash: cd: ${target}: No such file or directory\n`, 2); return 1 }
        this.vars.set('OLDPWD', getcwd())
        chdir(path)
        this.vars.set('PWD', path)
        return 0
      }
      case 'exit': await this.leave(args[0] === undefined ? this.status : Number(args[0])); return 0
      case 'export': {
        for (const arg of args) {
          const [name, ...value] = arg.split('=')
          if (value.length) this.set(name, value.join('='))
          this.state.markExported(name)
        }
        if (!args.length) for (const [name, value] of Object.entries(this.state.environment()).sort()) this.out(`export ${name}="${value}"\n`)
        return 0
      }
      case 'unset': {
        let status = 0
        for (const name of args.filter(a => !a.startsWith('-'))) {
          const element = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]$/.exec(name)
          if (element) { this.state.unsetArrayElement(element[1], evaluateArithmeticExpression(element[2], v => this.get(v))); continue }
          try { this.state.unset(name) } catch (error) { this.out(`ecmash: ${error.message}\n`, 2); status = 1; continue }
          this.functions.delete(name)
          this.state.unsetArray(name)
        }
        return status
      }
      case 'declare': {
        // Enough of `declare` for arrays and exports: `-a NAME` makes an empty array, `-x` exports,
        // `NAME=value` assigns. Other flags are accepted and ignored.
        const flags = args.filter(a => /^-[A-Za-z]+$/.test(a)).join('')
        for (const arg of args.filter(a => !/^-[A-Za-z]+$/.test(a))) {
          const [name, ...value] = arg.split('=')
          if (flags.includes('a')) { if (!this.state.lookupArray(name)) this.state.setArray(name, []) }
          else if (value.length) this.set(name, value.join('='))
          if (flags.includes('x')) this.state.markExported(name)
          if (flags.includes('r')) this.state.markReadonly(name)
        }
        return 0
      }
      case 'local': {
        for (const arg of args) {
          const [name, ...value] = arg.split('=')
          try { this.state.declareLocal(name, value.length ? value.join('=') : undefined) } catch {
            this.out('ecmash: local: can only be used in a function\n', 2)
            return 1
          }
        }
        return 0
      }
      case 'readonly': {
        if (!args.length) { for (const name of [...this.state.readonlyNames].sort()) this.out(`readonly ${name}="${this.get(name) ?? ''}"\n`); return 0 }
        let status = 0
        for (const arg of args.filter(a => !a.startsWith('-'))) {
          const [name, ...value] = arg.split('=')
          if (value.length && !this.set(name, value.join('='))) { status = 1; continue }
          this.state.markReadonly(name)
        }
        return status
      }
      case 'set': {
        if (!args.length) { for (const [n, v] of [...this.vars].sort()) this.out(`${n}=${v}\n`); return 0 }
        if (args[0] === '--') { this.positional = args.slice(1); return 0 }
        const letters = { e: 'errexit', u: 'nounset', x: 'xtrace' }
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]
          if (arg === '-o' || arg === '+o') {
            const name = args[++i]
            if (name === 'pipefail') this.opts.pipefail = arg === '-o'
            else if (name === 'errexit' || name === 'nounset' || name === 'xtrace') this.opts[name] = arg === '-o'
            else { this.out(`ecmash: set: ${name}: unsupported option\n`, 2); return 2 }
            continue
          }
          if (!/^[-+][a-z]+$/.test(arg)) { this.positional = args.slice(i); break }
          for (const letter of arg.slice(1)) {
            if (!letters[letter]) { this.out(`ecmash: set: ${arg[0]}${letter}: unsupported option\n`, 2); return 2 }
            this.opts[letters[letter]] = arg[0] === '-'
          }
        }
        return 0
      }
      case 'alias': {
        if (!args.length) { for (const [n, v] of [...this.aliases].sort()) this.out(`alias ${n}='${v}'\n`); return 0 }
        let status = 0
        for (const arg of args) {
          const at = arg.indexOf('=')
          if (at > 0) this.aliases.set(arg.slice(0, at), arg.slice(at + 1))
          else if (this.aliases.has(arg)) this.out(`alias ${arg}='${this.aliases.get(arg)}'\n`)
          else { this.out(`ecmash: alias: ${arg}: not found\n`, 2); status = 1 }
        }
        return status
      }
      case 'unalias': for (const n of args) this.aliases.delete(n); return 0
      case 'trap': {
        if (!args.length || args[0] === '-p') { for (const [sig, cmd] of this.traps) this.out(`trap -- '${cmd}' ${sig}\n`); return 0 }
        if (args[0] === '-l') { this.out(Object.keys(TRAP_SIGNALS).join(' ') + '\n'); return 0 }
        const [action, ...signals] = args
        for (const raw of signals) {
          let sig = raw.replace(/^SIG/, '').toUpperCase()
          if (/^\d+$/.test(sig)) sig = sig === '0' ? 'EXIT' : (Object.entries(TRAP_SIGNALS).find(([, n]) => n === Number(sig))?.[0] ?? sig)
          if (sig !== 'EXIT' && sig !== 'ERR' && !(sig in TRAP_SIGNALS)) { this.out(`ecmash: trap: ${raw}: unsupported signal (EXIT, ERR and ${Object.keys(TRAP_SIGNALS).join(', ')} are)\n`, 2); return 1 }
          if (action === '-' || action === '') {
            if (action === '-') this.traps.delete(sig); else this.traps.set(sig, '')
          } else this.traps.set(sig, action)
          // INT is reported by the wait that saw the child die; the rest arrive as real signals.
          if (sig in TRAP_SIGNALS && sig !== 'INT') {
            const number = TRAP_SIGNALS[sig]
            if (this.traps.has(sig)) onSignal(number, () => this.pending.push(sig))
            else if (sys.offSignal) sys.offSignal(number)
          }
        }
        return 0
      }
      case 'shift': this.positional = this.positional.slice(Number(args[0] ?? 1)); return 0
      case 'return': throw new ReturnSignal(Number(args[0] ?? this.status))
      case 'break': throw new BreakSignal(Number(args[0] ?? 1))
      case 'continue': throw new ContinueSignal(Number(args[0] ?? 1))
      case 'read': return this.read(args)
      case 'source': case '.': {
        const path = this.findSource(args[0])
        if (!path) { this.out(`ecmash: ${args[0]}: No such file or directory\n`, 2); return 1 }
        return await this.interpreter.runSourced(readFileText(path), args.length > 1 ? args.slice(1) : undefined)
      }
      case 'eval': return await this.interpreter.runSourced(args.join(' '))
      case 'exec': {
        if (!args.length) return 0
        const program = this.findProgram(args[0])
        if (!program) { this.out(`ecmash: exec: ${args[0]}: not found\n`, 2); return 127 }
        // No `execve` from a worker yet: run it, then leave with its status, which is what `exec` looks like from outside.
        const pid = await spawn(program, args, { env: this.environment(), fds: { 0: this.stdio[0], 1: this.stdio[1], 2: this.stdio[2] }, cwd: getcwd() })
        const done = await waitpid(pid, false)
        exit(done.signal ? 128 + done.signal : done.code)
        return 0
      }
      case 'type': case 'command': {
        const names = args.filter(a => !a.startsWith('-'))
        let status = 0
        for (const n of names) {
          if (this.functions.has(n)) this.out(`${n} is a function\n`)
          else if (BUILTINS.has(n)) this.out(`${n} is a shell builtin\n`)
          else { const p = this.findProgram(n); if (p) this.out(`${n} is ${p}\n`); else { this.out(`ecmash: type: ${n}: not found\n`, 2); status = 1 } }
        }
        return status
      }
      case 'test': case '[': {
        const list = name === '[' ? args.slice(0, -1) : args
        return this.test(list) ? 0 : 1
      }
      case 'wait': {
        if (!args.length) { for (const job of this.jobs.filter(j => j.done && !j.stopped)) await job.done; this.jobs = this.jobs.filter(j => !j.finished); return 0 }
        let status = 0
        for (const arg of args) {
          const job = this.pickJob(arg)
          if (!job) { this.out(`ecmash: wait: ${arg}: no such job\n`, 2); status = 127; continue }
          if (job.done) await job.done
          status = job.code
        }
        return status
      }
      case 'jobs': {
        for (const job of this.jobs) this.out(`[${job.number}]  ${job.stopped ? 'Stopped' : job.finished ? 'Done' : 'Running'}  ${job.line}${job.background && !job.stopped && !job.finished ? ' &' : ''}\n`)
        return 0
      }
      case 'disown': {
        const job = this.pickJob(args[0], true)
        if (!job) { this.out('ecmash: disown: no such job\n', 2); return 1 }
        this.jobs = this.jobs.filter(j => j !== job)
        return 0
      }
      case 'bg': case 'fg': {
        const job = this.pickJob(args[0], name === 'fg')
        if (!job) { this.out(`ecmash: ${name}: no current job\n`, 2); return 1 }
        const last = job.pids[job.pids.length - 1]
        if (name === 'bg') {
          if (!job.stopped) { this.out(`ecmash: bg: job ${job.number} already in background\n`, 2); return 1 }
          job.stopped = false
          job.background = true
          try { killpg(job.pgid, SIGCONT) } catch { /* it is gone */ }
          this.watch(job)
          this.out(`[${job.number}]+ ${job.line} &\n`)
          return 0
        }
        this.out(job.line + '\n')
        this.jobs = this.jobs.filter(j => j !== job)
        try { tcsetpgrp(last) } catch { /* no terminal */ }
        let status
        if (job.done && !job.stopped) { await job.done; status = job.code } else {
          job.stopped = false
          try { killpg(job.pgid, SIGCONT) } catch { /* it is gone */ }
          status = await job.handle.finish({ untraced: this.interactive })
          if (job.handle.stopped) {
            job.stopped = true
            this.jobs.push(job)
            writeAllFd(1, `\r\n[${job.number}]+  Stopped    ${job.line}\r\n`)
            this.restoreTerminal()
            return 128 + SIGTSTP
          }
        }
        this.restoreTerminal()
        return status
      }
    }
    return 127
  }

  /** `%n`, `n`, `%%`/nothing (the newest job; for `fg` and `bg` the newest stopped or background one). */
  pickJob(spec, preferRunning = false) {
    if (spec && /^%?\d+$/.test(spec)) return this.jobs.find(job => job.number === Number(spec.replace('%', '')) || job.pids.includes(Number(spec)))
    const candidates = this.jobs.filter(job => !job.finished)
    const stopped = candidates.filter(job => job.stopped)
    const pool = stopped.length ? stopped : (preferRunning ? candidates : candidates.filter(job => job.stopped))
    return pool[pool.length - 1]
  }

  findSource(name) {
    if (name.includes('/')) return isFile(resolvePath(name)) ? resolvePath(name) : undefined
    for (const dir of [getcwd(), ...(this.vars.get('PATH') ?? '').split(':')]) {
      if (dir && isFile(`${dir}/${name}`)) return `${dir}/${name}`
    }
  }

  read(args) {
    let raw = false
    const names = []
    for (const arg of args) { if (arg === '-r') raw = true; else if (!arg.startsWith('-')) names.push(arg) }
    // One byte at a time: `read` must not take more of the stream than its line.
    const bytes = []
    const one = new Uint8Array(1)
    let got = false
    for (;;) {
      const n = read(this.stdio[0], one, -1)
      if (n <= 0) break
      got = true
      if (one[0] === 10) break
      bytes.push(one[0])
    }
    if (!got) return 1
    let line = decoder.decode(new Uint8Array(bytes))
    if (!raw) line = line.replace(/\\(.)/g, '$1')
    const ifs = this.vars.get('IFS') ?? ' \t\n'
    const fields = ifs === '' ? [line] : line.split(new RegExp(`[${ifs.replace(/[\]\\^-]/g, '\\$&')}]+`)).filter((f, i) => f !== '' || i > 0)
    const targets = names.length ? names : ['REPLY']
    targets.forEach((target, index) => {
      const last = index === targets.length - 1
      this.set(target, last ? fields.slice(index).join(' ').trim() : (fields[index] ?? ''))
    })
    return 0
  }

  test(list) {
    const [a, b, c] = list
    if (list.length === 0) return false
    if (list.length === 1) return a !== ''
    if (a === '!') return !this.test(list.slice(1))
    if (list.length === 2) {
      switch (a) {
        case '-n': return b !== ''
        case '-z': return b === ''
        case '-e': return exists(resolvePath(b))
        case '-f': return isFile(resolvePath(b))
        case '-d': return isDir(resolvePath(b))
        case '-r': case '-w': case '-x': case '-s': return exists(resolvePath(b))
      }
      return false
    }
    switch (b) {
      case '=': case '==': return a === c
      case '!=': return a !== c
      case '-eq': return Number(a) === Number(c)
      case '-ne': return Number(a) !== Number(c)
      case '-lt': return Number(a) < Number(c)
      case '-le': return Number(a) <= Number(c)
      case '-gt': return Number(a) > Number(c)
      case '-ge': return Number(a) >= Number(c)
    }
    return false
  }
}

// -- interactive ----------------------------------------------------------------------------------

function promptText(shell) {
  const custom = shell.vars.get('PS1')
  if (custom) {
    const cwd = getcwd()
    const home = shell.vars.get('HOME')
    const tilde = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
    return custom
      .replace(/\\u/g, shell.vars.get('USER') ?? 'user')
      .replace(/\\h/g, 'ecmaos')
      .replace(/\\w/g, tilde)
      .replace(/\\W/g, cwd.split('/').pop() || '/')
      .replace(/\\\$/g, '$')
      .replace(/\\\[|\\\]/g, '')
  }
  return `ecmash${shell.status ? `[${shell.status}]` : ''}$ `
}

async function interactive(shell, tty) {
  shell.interactive = true
  const home = shell.vars.get('HOME') ?? '/'
  const historyFile = `${home}/.ecmash_history`
  const history = new History({
    fs: () => ({
      exists: async p => exists(p),
      readFile: async p => readFileText(p),
      writeFile: async (p, data) => writeWholeFile(p, data),
    }),
    file: () => historyFile,
    variable: name => shell.vars.get(name),
    error: () => {},
  })
  await history.load(0)

  // A handler has to exist for the signal to interrupt the read instead of ending the shell.
  onSignal(SIGINT, () => {})
  onSignal(SIGTSTP, () => {})

  for (;;) {
    // A blocking read on the terminal holds this worker's event loop, so a job's completion message is
    // still waiting; one turn of the loop lets it land before the jobs are looked at.
    await sleep(20)
    // Like bash, finished background jobs are reported when the next prompt is about to be drawn.
    for (const job of shell.jobs) {
      if (job.finished && !job.reported) {
        job.reported = true
        writeAllFd(1, `[${job.number}]+  ${job.code === 0 ? 'Done' : `Exit ${job.code}`}    ${job.line} &\r\n`)
      }
    }
    shell.jobs = shell.jobs.filter(job => !job.reported)
    const restore = rawMode(tty)
    let line
    try { line = await readLine(shell, tty, history) } finally { restore() }
    if (line === undefined) { writeAllFd(1, '\nexit\n'); return }
    if (!line.trim()) continue
    await history.add(0, line)
    try {
      let text = line
      while (needsMoreInput(text)) {
        const restoreMore = rawMode(tty)
        let more
        try { more = await readLine(shell, tty, history, '> ') } finally { restoreMore() }
        if (more === undefined) break
        text += '\n' + more
      }
      await shell.runText(text)
    } catch (error) {
      if (isUnwind(error)) continue
      writeAllFd(2, `ecmash: ${error?.message ?? error}\n`)
      shell.status = 2
    }
  }
}

/** One line from the terminal, edited in place. `undefined` on ^D at an empty line. */
async function readLine(shell, tty, history, fixedPrompt) {
  const prompt = fixedPrompt ?? promptText(shell)
  writeAllFd(1, stripMarkers(prompt))
  const host = {
    write: data => writeAllFd(1, data),
    get cols() { return terminalSize(tty).cols },
    promptWidth: () => visibleWidth(prompt),
  }
  const editor = new LineEditor(host)
  let position = 0
  const entries = []
  for (let i = 0; history.get(0, i) !== undefined; i++) entries.push(history.get(0, i))
  position = entries.length
  const buffer = new Uint8Array(1024)

  for (;;) {
    let n
    try { n = read(tty, buffer, -1) } catch (error) {
      // ^C: the line discipline raised SIGINT, which interrupts the read. Cancel the line.
      if (error?.code === 'EINTR') { writeAllFd(1, '^C\r\n'); return '' }
      throw error
    }
    if (n <= 0) return undefined
    for (const key of decodeKeys(buffer.subarray(0, n))) {
      switch (key) {
        case 'Enter': case '\n': writeAllFd(1, '\r\n'); return editor.text
        case '\x03': editor.reset(); writeAllFd(1, '^C\r\n'); return ''
        case '\x04': if (editor.length === 0) return undefined; editor.deleteForward(); break
        case '\x7f': case '\b': editor.backspace(); break
        case '\x01': case 'Home': editor.home(); break
        case '\x05': case 'End': editor.end(); break
        case '\x0b': editor.killToEnd(); break
        case '\x15': editor.killToStart(); break
        case '\x17': editor.killWordBackward(); break
        case '\x19': editor.yank(); break
        case '\x0c': writeAllFd(1, '\x1b[2J\x1b[H' + stripMarkers(prompt) + editor.text); break
        case '\t': {
          const provider = {
            listDir: async dir => readdir(resolvePath(dir)),
            isDirectory: async target => isDir(resolvePath(target)),
            variable: name => shell.vars.get(name),
            get cwd() { return getcwd() },
            expandTilde: text => (text.startsWith('~') ? (shell.vars.get('HOME') ?? '') + text.slice(1) : text),
            builtins: BUILTINS,
          }
          let matches = []
          try { matches = await completionMatches(editor.text, provider) } catch { /* nothing to offer */ }
          if (matches.length === 1) {
            editor.replace(matches[0], text => stripMarkers(prompt) + text)
          } else if (matches.length > 1) {
            const words = matches.map(match => match.split(' ').pop())
            writeAllFd(1, '\r\n' + words.join('  ') + '\r\n' + stripMarkers(prompt) + editor.text)
          }
          break
        }
        case 'ArrowLeft': editor.left(); break
        case 'ArrowRight': editor.right(); break
        case 'ArrowUp': case 'ArrowDown': {
          const next = position + (key === 'ArrowUp' ? -1 : 1)
          if (next < 0 || next > entries.length) break
          position = next
          editor.replace(entries[position] ?? '', text => stripMarkers(prompt) + text)
          break
        }
        default:
          if (key.length >= 1 && key >= ' ' && key !== '\x7f') editor.insert(key)
      }
    }
  }
}

// -- entry ----------------------------------------------------------------------------------------

async function main() {
  const argv = sys.argv.slice(1)
  let login = sys.argv[0]?.split('/').pop()?.startsWith('-') ?? false
  let command
  while (argv[0]?.startsWith('-') && argv[0].length > 1) {
    const flag = argv.shift()
    if (flag === '--') break
    if (flag === '-c') { command = argv.shift(); break }
    if (flag === '-l' || flag === '--login') login = true
  }

  const name = command !== undefined ? (argv.shift() ?? 'ecmash') : (argv[0] ?? 'ecmash')
  const script = command === undefined && argv.length ? argv.shift() : undefined
  const shell = new Shell(script ?? name, argv)

  if (login) {
    for (const file of ['/etc/profile', `${shell.vars.get('HOME') ?? ''}/.ecmash_profile`, `${shell.vars.get('HOME') ?? ''}/.profile`]) {
      if (isFile(file)) { try { await shell.runText(readFileText(file)) } catch { /* a broken profile must not lock the shell out */ } }
    }
  }

  let status = 0
  try {
    if (command !== undefined) status = await shell.runText(command)
    else if (script !== undefined) {
      if (!isFile(resolvePath(script))) { writeAllFd(2, `ecmash: ${script}: No such file or directory\n`); exit(127) }
      status = await shell.runText(readFileText(resolvePath(script)))
    } else if (isTty(0)) {
      const rc = `${shell.vars.get('HOME') ?? ''}/.ecmashrc`
      if (isFile(rc)) { try { await shell.runText(readFileText(rc)) } catch { /* ignore */ } }
      await interactive(shell, ttyFd())
    } else {
      status = await shell.runText(readFd(0))
    }
  } catch (error) {
    if (error instanceof ExitSignal) status = error.code
    else if (isUnwind(error)) status = 0
    else { writeAllFd(2, `ecmash: ${error?.message ?? error}\n`); status = 2 }
  }
  for (const job of shell.jobs) if (job.done && !job.stopped) await job.done
  await shell.leave(status)
}

await main()
