/**
 * `ecmash`: the ecmaOS shell as a worker program, on the same shell language as the kernel shell (`../lib/*` and
 * `shell-core`). It reaches the system through syscalls: `spawn`, `waitpid` and `killpg` for processes, `pipe` for
 * pipelines, `open` for redirections, terminal ioctls for the line editor.
 *
 *   ecmash [-l] [-c COMMAND [NAME [ARG...]]] [FILE [ARG...]]
 *
 * With no command or file it reads stdin; on a terminal it is interactive (prompt, line editing, history in
 * `~/.ecmash_history`, SIGINT cancels the line).
 * Builtins are the shared ones from `shell-core/builtins` plus those that need a process or job table (`echo`, `pwd`,
 * `env`, `wait`, `jobs`, `fg`, `bg`, `disown`, `exec`).
 * Output redirected to a file goes through a scratch file copied over when the command ends, since the root
 * filesystem corrupts a file written in several chunks through a plain descriptor.
 */

import { parseStatements, needsMoreInput } from '../lib/control-flow-parser.ts'
import { splitAssignments, parseArrayAssignment, applyArrayAssignment } from '../lib/shell-core/prepare.ts'
import { parseScript, parseRedirections, tokenize, tokenizeConditional } from '../lib/shell-parser.ts'
import { expandWordFieldsBraced, expandWordString, expandHeredocBody, GlobNoMatchError, UnboundVariableError } from '../lib/word-expansion.ts'
import { globPaths, globRegExp, hasGlobCharacters } from '../lib/glob.ts'
import { ArithmeticError, evaluateArithmeticExpression } from '../lib/expand-variables.ts'
import { evaluateConditional } from '../lib/conditional-eval.ts'
import { LineEditor, stripMarkers, visibleWidth } from '../lib/line-editor.ts'
import { History } from '../lib/history.ts'
import { ShellState, serializeSnapshot, deserializeSnapshot } from '../lib/shell-core/state.ts'
import { Interpreter } from '../lib/shell-core/interpreter.ts'
import { runSharedBuiltin, sharedBuiltinNames, shellQuote, testExpression } from '../lib/shell-core/builtins.ts'
import { programmableCompletion } from '../lib/shell-core/programmable-completion.ts'
import { promptCommands } from '../lib/shell-core/prompt-command.ts'
import { CONTROL_FLOW_KEYWORDS } from '../lib/control-flow-parser.ts'
import { BreakSignal, ContinueSignal, ExitSignal, ReturnSignal } from '../lib/shell-core/signals.ts'
import { parseEnvironment, startupFiles } from '../lib/shell-core/startup-files.ts'
import { SIGNAL_NUMBERS, UNCATCHABLE_SIGNALS } from '../lib/shell-core/signal-table.ts'
import { completionMatches } from '../lib/completion.ts'
import { rawMode, decodeKeys, ttyFd, isTty, terminalSize } from './lib/tty.mjs'
import { canonicalize } from './lib/canon.mjs'

const sys = globalThis.ecmaosSyscalls
const { poll, POLLIN, POLLHUP, POLLERR, open, close, read, write, pipe, stat, lstat, geteuid, getegid, unlink, readdir, getcwd, chdir, exit, spawn, waitpid, killpg, setpgid, tcsetpgrp, getpid, getppid, onSignal } = sys
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = sys
const O_APPEND = 0o2000

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const SIGINT = 2

/** How bash words the end of a background job: a signal by its description, a status as `Exit N`. */
const SIGNAL_DESCRIPTIONS = { 1: 'Hangup', 2: '', 3: 'Quit', 6: 'Aborted', 9: 'Killed', 11: 'Segmentation fault', 13: '', 14: 'Alarm clock', 15: 'Terminated', 10: 'User defined signal 1', 12: 'User defined signal 2' }
function jobEnd(job) {
  if (job.signal && SIGNAL_DESCRIPTIONS[job.signal] !== undefined) return SIGNAL_DESCRIPTIONS[job.signal] || 'Done'
  return job.code === 0 ? 'Done' : `Exit ${job.code}`
}
const SIGTSTP = 20
const SIGCONT = 18
// Signals `trap` can catch, and the number `onSignal` wants for each: all of them but KILL and STOP.
const TRAP_SIGNALS = Object.fromEntries(Object.entries(SIGNAL_NUMBERS).filter(([name]) => !UNCATCHABLE_SIGNALS.has(name)))

// - small fs helpers -----------------------------------------------------------------------------

function readFileText(path) {
  const fd = open(path, O_RDONLY, 0)
  try { return readFd(fd) } finally { close(fd) }
}

/** Whether `path` is text that does not start with `#!`: something `execve` cannot run, which the shell runs itself */
function isTextWithoutShebang(path) {
  // Bundled programs under /bin and /sbin and `.js` files are JavaScript, which `execve` runs itself
  if (/\.[cm]?js$/.test(path) || path.startsWith('/bin/') || path.startsWith('/sbin/')) return false
  const fd = open(path, O_RDONLY, 0)
  try {
    const head = new Uint8Array(512)
    const n = read(fd, head, -1)
    if (n <= 0) return false
    if (head[0] === 0x23 && head[1] === 0x21) return false
    return !head.subarray(0, n).includes(0)
  } finally { close(fd) }
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

/**
 * Adds `text` to the end of `path` in one write, as `>>` does: what is there is not rewritten (an append-only file is
 * only ever opened to append)
 */
function appendWholeFile(path, text) {
  const fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
  try { writeAllFd(fd, text) } finally { close(fd) }
}

const exists = path => { try { stat(path); return true } catch { return false } }
const isDir = path => { try { return (stat(path).mode & 0xf000) === 0x4000 } catch { return false } }
/** `$GROUPS`: the primary group, then the supplementary ones the kernel reports for this process. */
function groupIds(gid) {
  const ids = []
  if (gid !== undefined && gid !== '') ids.push(gid)
  try {
    const line = readFileText('/proc/self/status').split('\n').find(entry => entry.startsWith('Groups:'))
    for (const id of (line ?? '').slice(7).trim().split(/\s+/)) if (id !== '' && !ids.includes(id)) ids.push(id)
  } catch { /* no /proc: the primary group alone */ }
  return ids
}

const isFile = path => { try { return (stat(path).mode & 0xf000) === 0x8000 } catch { return false } }
const resolvePath = (path, cwd = getcwd()) => normalize(path.startsWith('/') ? path : `${cwd}/${path}`)

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

// - shell state ----------------------------------------------------------------------------------

/** A `break`, `continue`, `return` or `exit` unwinding: not an error to report. */
const isUnwind = error => error instanceof BreakSignal || error instanceof ContinueSignal || error instanceof ReturnSignal || error instanceof ExitSignal

// The ones that need this shell's own machinery (its job table, its descriptors, `exec`); every other
// builtin is shared with the kernel shell (`../lib/shell-core/builtins.ts`).
const OWN_BUILTINS = ['true', 'false', 'pwd', 'env', 'wait', 'jobs', 'fg', 'bg', 'disown', 'exec']
const BUILTINS = new Set([...sharedBuiltinNames, ...OWN_BUILTINS])

class Shell {
  constructor(name, args) {
    // What the process was started with is inherited by its children; what the shell assigns is not, until `export`.
    /** Redirections `exec` installed on this shell, finished when it leaves. */
    this.execRedirections = []
    this.state = new ShellState({ pid: getpid, ppid: getppid, groups: () => groupIds(this.state.vars.get('GID')) }, new Map(Object.entries(sys.env)))
    this.positional = args
    this.name = name
    this.status = 0
    this.jobs = []
    this.scratch = 0
    this.depth = 0
    this.interactive = false
    this.leaving = false
    // Set when a foreground command died of ^C; the interpreter stops the current line, and the prompt clears it.
    this.sigint = false
    this.procsubs = []
    this.procsubCount = 0
    this.pending = []
    this.interpreter = new Interpreter(this.hostInterface(), this.state, { maxFunctionDepth: 200 })
    // Written straight into the store, so they count as inherited: a child shell nests one deeper, and PWD is
    // exported.
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
  set(name, value, append = false) {
    try {
      this.state.set(name, value, append)
      return true
    } catch (error) {
      writeAllFd(2, `ecmash: ${error.message}\n`)
      this.failedAssignment = true
      return false
    }
  }

  environment() { return this.state.environment() }
  /** What the shell's own messages start with: `ecmash: `, or `./script: line N: ` while a script file runs, as bash does. */
  diagPrefix() {
    const file = this.state.currentSourceFile()
    return file ? `${file}: line ${this.state.lineNumber}: ` : 'ecmash: '
  }

  // - expansion ----------------------------------------------------------------------------------

  context() {
    return {
      lookup: name => this.get(name),
      lookupArray: name => this.state.lookupArray(name),
      isAssoc: name => this.state.isAssoc(name),
      positional: () => this.positional,
      assign: (name, value) => this.set(name, value),
      substitute: command => this.substitute(command),
      processSubstitute: (direction, command) => this.processSubstitute(direction, command),
      glob: pattern => this.glob(pattern),
      home: () => this.vars.get('HOME'),
      userHome: name => {
        try {
          for (const line of readFileText('/etc/passwd').split('\n')) {
            const fields = line.split(':')
            if (fields[0] === name && fields[5]) return fields[5]
          }
        } catch { /* no passwd file: no such user */ }
        return undefined
      },
      nounset: this.opts.nounset,
      shopt: name => this.state.shopts.has(name),
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
      // A subshell: `exit` inside ends only the substitution, and its status is what `x=$(cmd)` reports.
      this.substStatus = await this.runSubshell(parseStatements(command))
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
   * `<(cmd)` and `>(cmd)` as a temporary file standing in for the far end of a pipe. `<(cmd)` runs first; `>(cmd)`
   * runs afterwards with the file as stdin. Removed by `finishProcSubs`. Does not stream.
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

  // - arrays -------------------------------------------------------------------------------------

  /**
   * `a=(x y)`, `a+=(z)` and `a[i]=v` at the start of a line. Returns the status, or `undefined` when
   * the line is not one. The parser splits `a=(x y)` into two words, which is why this reads the raw
   * text instead of the tokens.
   */
  async arrayAssignment(line) {
    const found = parseArrayAssignment(line)
    if (!found) return undefined
    await applyArrayAssignment(found, this.state, {
      fields: parts => this.fields(parts),
      text: parts => this.text(parts),
      lookup: variable => this.get(variable)
    })
    return await this.afterAssignment(found.operator, found.rest)
  }

  async afterAssignment(operator, rest) {
    if (!rest) return 0
    if (operator === '||') return 0
    return await this.runLine(rest)
  }

  /** What `shopt` has changed about how a pattern matches. */
  patternOptions() {
    const on = name => this.state.shopts.has(name)
    return { extglob: on('extglob'), dotglob: on('dotglob'), globstar: on('globstar'), nocase: on('nocaseglob') }
  }

  async glob(pattern) {
    if (this.opts.noglob) return []
    const options = this.patternOptions()
    if (!hasGlobCharacters(pattern, options)) return []
    return await globPaths(pattern, {
      readdir: dir => readdir(resolvePath(dir)),
      isDirectory: path => isDir(resolvePath(path)),
      exists: path => exists(resolvePath(path)),
    }, options)
  }

  // - running text -------------------------------------------------------------------------------

  async runText(text) { return await this.interpreter.runText(text) }
  async runStatements(statements) { return await this.interpreter.runStatements(statements) }
  async runSubshell(statements) { return await this.interpreter.runSubshell(statements) }
  async runLine(line) { return await this.interpreter.runLine(line) }
  async callFunction(name, args) { return await this.interpreter.callFunction(name, args) }

  /**
   * What the shared interpreter needs from this shell: how to run a pipeline, and the per-process pieces of state.
   */
  hostInterface() {
    const shell = this
    return {
      runPipeline: async pipeline => {
        shell.lastStatuses = undefined
        const status = await shell.runPipeline(pipeline)
        // every stage's status, for PIPESTATUS; one entry when the pipeline stopped, was negated, or never started
        return shell.lastStatuses ?? [status]
      },
      runBackground: pipeline => shell.runBackground(pipeline),
      runSpecial: line => shell.arrayAssignment(line),
      withRedirect: (statement, run) => shell.withRedirect(statement, run),
      expandWords: text => shell.expandWords(text),
      caseSubject: async word => (await shell.expandWords(word))[0] ?? '',
      matchesPattern: (subject, pattern) => globRegExp(pattern.replace(/^["']|["']$/g, ''), { extglob: shell.state.shopts.has('extglob'), nocase: shell.state.shopts.has('nocasematch') }).test(subject),
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
      checkpoint: async () => { await shell.runPendingTraps(); return shell.sigint },
      exitShell: code => shell.leave(code),
      writeErr: message => { writeAllFd(2, `${this.diagPrefix()}${message}\n`) },
      nonInteractive: () => !this.interactive,
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
      // the trap sees the status the shell is exiting with as `$?`
      this.status = code & 0xff
      if (trap) { try { await this.runText(trap) } catch { /* the shell is going anyway */ } }
    }
    for (const applied of this.execRedirections.splice(0)) { try { await applied.finish() } catch { /* leaving anyway */ } }
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

  // - pipelines ----------------------------------------------------------------------------------

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
      record.signal = record.handle.endSignal || 0
    })
  }

  /**
   * `( ... ) &`, `{ ...; } &`, `while ...; done &`: there is no `fork`, so the compound command runs in a
   * fresh `ecmash` that is given this shell's state (variables, arrays, functions, aliases, traps, options,
   * positional parameters, `$?`) and the statement itself, as JSON. Returns the same handle a pipeline does.
   */
  async forkCompound(statement, pipeline) {
    const file = this.scratchPath()
    const payload = JSON.stringify({
      state: serializeSnapshot(this.state.snapshot()),
      positional: this.positional,
      name: this.name,
      status: this.status,
      statement,
      pipeline,
    })
    const fd = open(file, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    try { writeAllFd(fd, payload) } finally { close(fd) }
    const childFds = {}
    for (const target of [0, 1, 2]) childFds[target] = this.stdio[target] ?? target
    let pid
    try {
      pid = await spawn(this.selfPath(), ['ecmash', '--run-forked', file], { env: this.environment(), fds: childFds, cwd: getcwd(), pgid: 0 })
    } catch (error) {
      try { unlink(file) } catch { /* gone */ }
      throw error
    }
    const handle = { pids: [pid], leader: pid, stopped: false, statuses: undefined, finish: null }
    handle.finish = async ({ untraced = false } = {}) => {
      handle.stopped = false
      let done
      for (;;) {
        try { done = await waitpid(pid, false, untraced) } catch (error) {
          if (error?.code === 'EINTR') { await this.runPendingTraps(); continue }
          throw error
        }
        if (done.stopped) { handle.stopped = true; return 128 + SIGTSTP }
        break
      }
      try { unlink(file) } catch { /* gone */ }
      const status = done.signal ? 128 + done.signal : done.code
      handle.statuses = [status]
      handle.endSignal = done.signal || 0
      handle.interrupted = done.signal === SIGINT
      return status
    }
    return handle
  }

  /** The program file this shell was started from, so a forked child runs the same one. */
  selfPath() {
    return this.findProgram('ecmash') ?? '/bin/ecmash'
  }

  async runBackground(pipeline) {
    const compound = pipeline.commands.length === 1 ? pipeline.commands[0].compound : undefined
    // a compound stage inside a longer pipeline runs in this process, which cannot also carry on with the prompt: the
    // whole pipeline goes to a forked shell
    const mixed = !compound && pipeline.commands.some(command => command.compound)
    const mark = this.procsubs.length
    let job
    if (compound || mixed) {
      try { job = await this.forkCompound(compound, mixed ? pipeline : undefined) } catch (error) { writeAllFd(2, `${this.diagPrefix()}${error?.message ?? error}\n`); return 1 }
    } else job = await this.startPipeline(pipeline, true)
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
    // A foreground command killed by ^C ends the list or loop it is in, as in bash (its INT trap has already run).
    // A status of 130 is not that: `wait` on a job someone sent INT to, or `(exit 130)`, is an ordinary status.
    if (job.interrupted) this.sigint = true
    await this.finishProcSubs(mark)
    if (job.stopped) {
      // ^Z: the job stays in the table, stopped, until `fg` or `bg` resumes it.
      const record = this.addJob(job, pipeline, { stopped: true })
      writeAllFd(1, `\r\n[${record.number}]+  Stopped    ${record.line}\r\n`)
      await this.restoreTerminal()
      return 128 + SIGTSTP
    }
    await this.restoreTerminal()
    this.lastStatuses = pipeline.negated ? undefined : job.statuses
    return pipeline.negated ? (status === 0 ? 1 : 0) : status
  }

  /** The terminal goes back to this shell once a foreground job has finished or stopped. */
  async restoreTerminal() {
    if (!this.interactive) return
    try { await tcsetpgrp(getpid()) } catch { /* no terminal */ }
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
    // Compound stages (`... | while read x; do ...; done`) run here, in this process. They wait until
    // every program in the pipeline has been spawned, so a producer's output has a reader by the time
    // it is written, and their ends of the pipes stay open until they have run.
    const deferred = []
    // What each stage ended with, in pipeline order, for `PIPESTATUS`: a spawned program's pid to wait for, or a
    // status already known.
    const stages = []

    for (const [index, command] of commands.entries()) {
      const last = index === commands.length - 1
      let next
      const fds = { ...this.stdio, 0: inherited }
      if (!last) {
        next = pipe()
        fds[1] = next[1]
      }

      if (command.compound) {
        const closing = []
        if (inherited !== this.stdio[0]) closing.push(inherited)
        if (next) closing.push(next[1])
        const entry = { status: 0 }
        stages.push(entry)
        deferred.push({ command, fds, closing, entry })
        if (next) inherited = next[0]
        continue
      }

      try {
        const result = await this.runCommand(command, fds, { pgid: leader, background, single: commands.length === 1 })
        if (result.pid !== undefined) {
          pids.push(result.pid)
          stages.push({ pid: result.pid })
          if (!leader) leader = result.pid
        } else {
          stages.push({ status: result.status })
          statusOfBuiltin = result.status
          if (result.status) builtinFailure = result.status
        }
        if (result.finish) cleanups.push(result.finish)
      } catch (error) {
        // `set -u` is the interpreter's to report, and to end a script over
        if (isUnwind(error) || error instanceof UnboundVariableError || error instanceof ArithmeticError) throw error
        writeAllFd(2, `${this.diagPrefix()}${error?.message ?? error}\n`)
        // `shopt -s failglob`: a pattern that matched nothing fails its command with 1, as in bash
        statusOfBuiltin = error instanceof GlobNoMatchError ? 1 : error?.code === 'ENOENT' ? 127 : 126
        stages.push({ status: statusOfBuiltin })
        failed = true
      }

      // The parent's copies of a pipe's ends have to go, or a reader never sees EOF.
      if (inherited !== this.stdio[0]) close(inherited)
      if (next) { close(next[1]); inherited = next[0] }
      if (failed) statusOfBuiltin = statusOfBuiltin ?? 1
    }
    for (const stage of deferred) {
      const saved = this._stdio
      this._stdio = stage.fds
      try {
        statusOfBuiltin = await this.interpreter.runStage(stage.command.compound)
        stage.entry.status = statusOfBuiltin
        if (statusOfBuiltin) builtinFailure = statusOfBuiltin
      } catch (error) {
        // `set -u` is the interpreter's to report, and to end a script over
        if (isUnwind(error) || error instanceof UnboundVariableError || error instanceof ArithmeticError) throw error
        writeAllFd(2, `${this.diagPrefix()}${error?.message ?? error}\n`)
        statusOfBuiltin = 1
        stage.entry.status = 1
      } finally {
        this._stdio = saved
        for (const fd of stage.closing) { try { close(fd) } catch { /* already closed */ } }
      }
    }
    if (inherited !== this.stdio[0]) { try { close(inherited) } catch { /* already closed */ } }

    const reaped = new Map()
    const handle = { pids, leader, stopped: false, finish: null, statuses: undefined }
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
            if (leader) { try { await killpg(leader, SIGTSTP) } catch { /* already stopped */ } }
            return
          }
          reaped.set(pid, done)
          // The terminal signals only its foreground process; the rest of the pipeline is ours to stop.
          if (done.signal === SIGINT && !interrupted && leader) {
            interrupted = true
            try { await killpg(leader, SIGINT) } catch { /* everyone already exited */ }
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
        if (pid === pids[pids.length - 1]) { statusOfLast = code; handle.endSignal = done.signal || 0 }
      }
      const status = this.opts.pipefail && failure !== 0 ? failure : statusOfLast
      handle.statuses = stages.map(stage => {
        if (stage.pid === undefined) return stage.status
        const done = reaped.get(stage.pid)
        return done.signal ? 128 + done.signal : done.code
      })
      handle.interrupted = interrupted
      // A foreground stage killed by ^C runs the INT trap, as the kernel shell does.
      if (interrupted && this.traps.has('INT')) { try { await this.runText(this.traps.get('INT')) } catch { /* ignore */ } }
      for (const cleanup of cleanups.splice(0)) await cleanup()
      return status
    }
    return handle
  }

  // - one command --------------------------------------------------------------------------------

  async runCommand(command, fds, options) {
    if (command.conditional !== undefined) {
      const ok = await evaluateConditional(tokenizeConditional(command.conditional), this.context(), {
        exists: async p => exists(resolvePath(p)),
        isFile: async p => isFile(resolvePath(p)),
        isDirectory: async p => isDir(resolvePath(p)),
        resolve: p => resolvePath(p),
        test: words => testExpression(this.builtinHost(), words),
      }, groups => this.state.setArray('BASH_REMATCH', groups))
      return { status: ok ? 0 : 1 }
    }

    this.substStatus = undefined
    const split = splitAssignments(command)
    const assign = []
    for (const { name, append, parts } of split.assignments) {
      const value = await this.text(parts)
      assign.push([name, append ? (this.get(name) ?? '') + value : value, append, value])
    }
    const args = []
    for (const parts of split.command.wordParts) args.push(...await this.fields(parts))

    // `$_`: the last word of the command, which the next one reads
    if (args.length) this.state.set('_', args[args.length - 1])

    if (!args.length) {
      for (const [name, , append, value] of assign) {
        if (this.set(name, value, append)) continue
        // A readonly assignment fails its command and the rest of its line; bash carries on with the next line.
        this.state.failedLine = this.state.lineNumber
        return { status: 1 }
      }
      return { status: this.substStatus ?? 0 }
    }

    // An alias stands in for the command word once (no chains), as in a POSIX shell.
    if (this.aliases.has(args[0])) {
      const expansion = await this.expandWords(this.aliases.get(args[0]))
      args.splice(0, 1, ...expansion)
      if (!args.length) return { status: 0 }
    }
    if (this.opts.xtrace) writeAllFd(2, `+ ${args.join(' ')}\n`)
    // `set -C`: a plain `>` refuses an existing regular file (`>|` overrides, `>>` appends).
    if (this.opts.noclobber) {
      for (const redirection of command.redirections) {
        if (redirection.type !== '>') continue
        const target = resolvePath(await this.text(redirection.targetParts ?? [{ text: redirection.target, quoting: 'unquoted' }]))
        if (isFile(target)) { writeAllFd(2, `${this.diagPrefix()}${target}: cannot overwrite existing file\n`); return { status: 1 } }
      }
    }
    const applied = await this.openRedirections(command.redirections, fds)
    const finish = async () => { await applied.finish() }
    const name = args[0]

    // `exec > file` with no command: the redirections stay on the shell itself, for everything that follows
    // (what it starts inherits them). A file that went through a scratch copy lands when the shell leaves.
    if (name === 'exec' && args.length === 1 && command.redirections.length > 0 && !this.functions.has('exec')) {
      this._stdio = applied.fds
      this.execRedirections.push(applied)
      return { status: 0 }
    }

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
      writeAllFd(2, `${this.diagPrefix()}${name}: command not found\n`)
      await finish()
      return { status: 127 }
    }

    const env = this.environment()
    for (const [n, v] of assign) env[n] = v
    const childFds = {}
    for (const target of [0, 1, 2]) childFds[target] = applied.fds[target] ?? target
    let pid
    let argv = [name, ...args.slice(1)]
    // `kill %1`: a job spec names the processes of one of this shell's jobs
    if (name === 'kill') argv = argv.flatMap((arg, index) => index > 0 && arg.startsWith('%') ? (this.jobForSpec(arg)?.pids.map(String) ?? [arg]) : [arg])
    let target = program
    // An executable text file with no `#!` line is a shell script, as in bash (the kernel runs one the same way)
    if (isTextWithoutShebang(program)) { target = '/bin/ecmash'; argv = ['ecmash', name.includes('/') ? name : program, ...args.slice(1)] }
    // Each pipeline is a group of its own. With job control (an interactive shell) a foreground one is given the
    // terminal as its first program starts; without it (`sh -c`, a script) a foreground pipeline stays in this
    // shell's group, which is in front of the terminal when the shell is, as in a POSIX sh.
    const group = this.interactive ? { pgid: options.pgid, foreground: !options.background && options.pgid === 0 }
      : options.background ? { pgid: options.pgid } : {}
    try {
      pid = await spawn(target, argv, { env, fds: childFds, cwd: getcwd(), ...group })
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

  // - redirections -------------------------------------------------------------------------------

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
        let handle
        if (path === '/dev/null') {
          // A device read reports the whole size asked for whatever the driver produced, so a reader of
          // /dev/null never sees the end of file; a pipe with nothing in it and no writer does.
          const [r, w] = pipe()
          close(w)
          handle = r
        } else {
          handle = open(path, O_RDONLY, 0)
        }
        opened.push(handle)
        fds[fd] = handle
        continue
      }
      if (redirection.type === '<<'|| redirection.type === '<<<') {
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
        // Creating the target now makes `> f` truncate immediately, as in every shell, and a target that cannot be
        // written fails the command before it runs.
        if (!record.append) writeWholeFile(path, '')
        else close(open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644))
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
          if (record.append) appendWholeFile(record.path, body)
          else writeWholeFile(record.path, body)
        }
        copies.length = 0
      },
    }
  }

  // - builtins -----------------------------------------------------------------------------------

  out(text, fd = 1) { writeAllFd(this.stdio[fd] ?? fd, text) }

  /** The three descriptors as the shared builtins see them. A diagnostic carries this shell's name. */
  builtinIO() {
    const stdio = this.stdio
    const to = (fd, text) => writeAllFd(stdio[fd] ?? fd, text)
    return {
      write: text => to(1, text),
      writeln: text => to(1, text + '\n'),
      writeErr: text => to(2, text),
      writelnErr: text => to(2, `${this.diagPrefix()}${text}\n`),
      // `read -t` waits with `poll`, so a pipe or file that never delivers does not hold the shell for good.
      canTimeout: true,
      // One byte at a time: `read` must not take more of the stream than its line.
      readLine: async options => {
        if (options?.prompt) to(2, options.prompt)
        const stop = options?.delimiter === undefined ? 10 : options.delimiter === '' ? 0 : options.delimiter.charCodeAt(0)
        const bytes = []
        const one = new Uint8Array(1)
        let got = false
        let terminated = false
        const deadline = options?.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs
        for (;;) {
          // `-n` counts bytes here, which is characters for ASCII.
          if (options?.count !== undefined && bytes.length >= options.count) { terminated = true; break }
          if (deadline !== undefined) {
            const [ready] = poll([{ fd: options?.fd ?? stdio[0] ?? 0, events: POLLIN }], Math.max(0, deadline - Date.now()))
            if (!(ready & (POLLIN | POLLHUP | POLLERR))) {
              // Nothing more arrived in time; what did is still assigned, and the status says so.
              if (options.result) options.result.timedOut = true
              return got ? decoder.decode(new Uint8Array(bytes)) : undefined
            }
          }
          const n = read(options?.fd ?? stdio[0] ?? 0, one, -1)
          if (n <= 0) break
          got = true
          if (one[0] === stop) { terminated = true; break }
          bytes.push(one[0])
        }
        if (options?.result) options.result.terminated = terminated
        return got ? decoder.decode(new Uint8Array(bytes)) : undefined
      },
    }
  }

  /** What the shared builtins need from this shell. */
  builtinHost() {
    const shell = this
    return {
      state: shell.state,
      interpreter: shell.interpreter,
      cwd: () => getcwd(),
      chdir: async target => {
        if (!isDir(target)) return exists(target) ? 'Not a directory' : 'No such file or directory'
        chdir(target)
        return undefined
      },
      resolvePath: path => resolvePath(path),
      realpath: async path => canonicalize(path, getcwd(), sys, { mode: 'e' }),
      stat: async path => {
        try {
          const info = stat(path)
          const kind = info.mode & 0xf000
          return { file: kind === 0x8000, directory: kind === 0x4000, size: Number(info.size ?? 0) }
        } catch { return undefined }
      },
      fileInfo: async (path, follow) => {
        try {
          const info = follow ? stat(path) : lstat(path)
          return {
            mode: Number(info.mode), uid: Number(info.uid ?? 0), gid: Number(info.gid ?? 0), dev: Number(info.dev ?? 0), ino: Number(info.ino ?? 0),
            size: Number(info.size ?? 0), atimeMs: Number(info.atimeMs ?? 0), mtimeMs: Number(info.mtimeMs ?? 0)
          }
        } catch { return undefined }
      },
      identity: () => ({ uid: geteuid(), gid: getegid(), groups: [] }),
      isTerminal: fd => isTty(fd),
      readFile: async path => readFileText(path),
      listDir: async dir => readdir(resolvePath(dir)),
      builtinNames: () => BUILTINS,
      writeFile: async (path, text) => {
        const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        try { writeAllFd(fd, text) } finally { close(fd) }
      },
      removeFile: async path => { unlink(path) },
      positional: () => shell.positional,
      setPositional: args => { shell.positional = args },
      getStatus: () => shell.status,
      describe: async name => {
        if (shell.aliases.has(name)) return { kind: 'alias' }
        if (CONTROL_FLOW_KEYWORDS.has(name)) return { kind: 'keyword' }
        if (BUILTINS.has(name)) return { kind: 'builtin' }
        if (shell.functions.has(name)) return { kind: 'function' }
        const program = shell.findProgram(name)
        return program ? { kind: 'file', path: program } : undefined
      },
      runArgv: argv => shell.interpreter.runText(argv.map(shellQuote).join(' ')),
      isLoginShell: () => Boolean(shell.login),
      fileSizeLimit: async () => {
        const bytes = Number(await sys.custom('proc_file_limit'))
        return bytes < 0 ? undefined : bytes
      },
      // the mask is this process's own (the interpreter in the worker applies it) and what it starts inherits it
      umask: async mask => sys.umask(mask),
      // INT is reported by the wait that saw the child die; the rest arrive as real signals.
      trapSignal: (signal, handler) => {
        if (signal in TRAP_SIGNALS && signal !== 'INT') {
          const number = TRAP_SIGNALS[signal]
          if (handler !== undefined) onSignal(number, () => shell.pending.push(signal))
          // an interactive shell keeps ignoring ^Z once its trap is gone, or it would stop itself
          else if (signal === 'TSTP' && shell.interactive) onSignal(number, () => {})
          else if (sys.offSignal) sys.offSignal(number)
        }
        return undefined
      },
    }
  }

  async builtin(name, args) {
    switch (name) {
      case 'true': return 0
      case 'false': return 1
      case 'env': {
        if (args.length) { this.out(`${this.diagPrefix()}env: running a command with env is not supported\n`, 2); return 2 }
        const env = this.environment()
        for (const key of Object.keys(env).sort()) this.out(`${key}=${env[key]}\n`)
        return 0
      }
      case 'pwd': this.out(getcwd() + '\n'); return 0
      case 'exec': {
        if (!args.length) return 0
        const program = this.findProgram(args[0])
        if (!program) { this.out(`${this.diagPrefix()}exec: ${args[0]}: not found\n`, 2); return 127 }
        // No `execve` from a worker yet: run it, then leave with its status, which is what `exec` looks like from
        // outside.
        const pid = await spawn(program, args, { env: this.environment(), fds: { 0: this.stdio[0], 1: this.stdio[1], 2: this.stdio[2] }, cwd: getcwd() })
        const done = await waitpid(pid, false)
        exit(done.signal ? 128 + done.signal : done.code)
        return 0
      }
      case 'wait': {
        if (!args.length) { for (const job of this.jobs.filter(j => j.done && !j.stopped)) await job.done; this.jobs = this.jobs.filter(j => !j.finished); return 0 }
        let status = 0
        for (const arg of args) {
          const job = this.pickJob(arg)
          if (!job) { this.out(`${this.diagPrefix()}wait: ${arg.startsWith('%') ? `${arg}: no such job` : `pid ${arg} is not a child of this shell`}\n`, 2); status = 127; continue }
          if (job.done) await job.done
          status = job.code
        }
        return status
      }
      case 'jobs': {
        this.jobs.forEach((job, index) => {
          const marker = index === this.jobs.length - 1 ? '+' : index === this.jobs.length - 2 ? '-' : ' '
          const label = job.stopped ? 'Stopped' : job.finished ? jobEnd(job) : 'Running'
          this.out(`[${job.number}]${marker}  ${label.padEnd(27)}${job.line}${job.background && !job.stopped && !job.finished ? ' &' : ''}\n`)
        })
        return 0
      }
      case 'disown': {
        const job = this.pickJob(args[0], true)
        if (!job) { this.out(`${this.diagPrefix()}disown: no such job\n`, 2); return 1 }
        this.jobs = this.jobs.filter(j => j !== job)
        return 0
      }
      case 'bg': case 'fg': {
        const job = this.pickJob(args[0], name === 'fg')
        if (!job) { this.out(`${this.diagPrefix()}${name}: no current job\n`, 2); return 1 }
        const last = job.pids[job.pids.length - 1]
        if (name === 'bg') {
          if (!job.stopped) { this.out(`${this.diagPrefix()}bg: job ${job.number} already in background\n`, 2); return 1 }
          job.stopped = false
          job.background = true
          try { await killpg(job.pgid, SIGCONT) } catch { /* it is gone */ }
          this.watch(job)
          this.out(`[${job.number}]+ ${job.line} &\n`)
          return 0
        }
        this.out(job.line + '\n')
        this.jobs = this.jobs.filter(j => j !== job)
        try { await tcsetpgrp(last) } catch { /* no terminal */ }
        let status
        if (job.done && !job.stopped) { await job.done; status = job.code } else {
          job.stopped = false
          try { await killpg(job.pgid, SIGCONT) } catch { /* it is gone */ }
          status = await job.handle.finish({ untraced: this.interactive })
          if (job.handle.stopped) {
            job.stopped = true
            this.jobs.push(job)
            writeAllFd(1, `\r\n[${job.number}]+  Stopped    ${job.line}\r\n`)
            await this.restoreTerminal()
            return 128 + SIGTSTP
          }
        }
        await this.restoreTerminal()
        return status
      }
    }
    return await runSharedBuiltin(this.builtinHost(), name, args, this.builtinIO())
  }

  /** `%n`, `n`, `%%`/nothing (the newest job; for `fg` and `bg` the newest stopped or background one). */
  /** `%n`, `%%`, `%+`, `%-` and `%name` (the latest job whose command starts with it) */
  jobForSpec(spec) {
    const live = this.jobs.filter(job => !job.finished)
    if (/^%\d+$/.test(spec)) return live.find(job => job.number === Number(spec.slice(1)))
    if (spec === '%' || spec === '%%' || spec === '%+') return live[live.length - 1]
    if (spec === '%-') return live[live.length - 2]
    return [...live].reverse().find(job => job.line.startsWith(spec.slice(1)))
  }

  pickJob(spec, preferRunning = false) {
    if (spec && /^%?\d+$/.test(spec)) return this.jobs.find(job => job.number === Number(spec.replace('%', '')) || job.pids.includes(Number(spec)))
    const candidates = this.jobs.filter(job => !job.finished)
    const stopped = candidates.filter(job => job.stopped)
    const pool = stopped.length ? stopped : (preferRunning ? candidates : candidates.filter(job => job.stopped))
    return pool[pool.length - 1]
  }

}

// - interactive ----------------------------------------------------------------------------------

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
        writeAllFd(1, `[${job.number}]+  ${jobEnd(job)}    ${job.line} &\r\n`)
      }
    }
    shell.jobs = shell.jobs.filter(job => !job.reported)
    // PROMPT_COMMAND runs after the job notices and before PS1, and leaves `$?` as the last command had it.
    const status = shell.status
    for (const text of promptCommands(shell.state)) {
      try { await shell.runText(text) } catch (error) { if (!isUnwind(error)) writeAllFd(2, `ecmash: PROMPT_COMMAND: ${error?.message ?? error}\n`) }
    }
    shell.status = status
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
      shell.sigint = false
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
            programmable: line => programmableCompletion(shell.builtinHost(), line),
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

// - entry ----------------------------------------------------------------------------------------

async function main() {
  const argv = sys.argv.slice(1)
  // A background compound command, started by `forkCompound`: the state and statement come in a file.
  if (argv[0] === '--run-forked') {
    const file = argv[1]
    const payload = JSON.parse(readFileText(file))
    const shell = new Shell(payload.name, payload.positional)
    shell.state.restore(deserializeSnapshot(payload.state))
    shell.status = payload.status
    // as in bash, a subshell starts with its traps reset
    shell.state.traps.clear()
    let status = 0
    try {
      status = payload.pipeline ? await shell.interpreter.runForkedPipeline(payload.pipeline) : await shell.interpreter.runStage(payload.statement)
    } catch (error) {
      if (error instanceof ExitSignal) status = error.code
      else if (isUnwind(error)) status = 0
      else { writeAllFd(2, `ecmash: ${error?.message ?? error}\n`); status = 2 }
    }
    await shell.leave(status)
  }

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
  shell.login = login

  // Which startup files run is shared with the kernel shell (`shell-core/startup-files`). A login shell
  // reads the profile files here; the rc files wait until we know the shell is interactive.
  const startupHost = {
    isFile: path => isFile(path),
    list: dir => { try { return readdir(dir) } catch { return [] } }
  }
  const runStartupFile = async file => {
    shell.state.pushSourceFrame(file, 0)
    try { await shell.runText(readFileText(file)) } catch (error) {
      if (error instanceof ExitSignal) return false
      /* a broken startup file must not lock the shell out */
    } finally { shell.state.popSourceFrame() }
    return true
  }
  if (login) {
    // /etc/environment is variables, not a script, and comes before every file; set straight into the store, so children inherit them
    try { for (const [key, value] of Object.entries(parseEnvironment(readFileText('/etc/environment')))) shell.vars.set(key, value) } catch { /* no /etc/environment */ }
    for (const file of await startupFiles({ home: shell.vars.get('HOME'), login: true, interactive: false }, startupHost)) {
      if (!await runStartupFile(file)) break
    }
  }

  let status = 0
  try {
    if (command !== undefined) status = await shell.runText(command)
    else if (script !== undefined) {
      if (!isFile(resolvePath(script))) { writeAllFd(2, `ecmash: ${script}: No such file or directory\n`); exit(127) }
      shell.state.pushSourceFrame(script, 0)
      status = await shell.runText(readFileText(resolvePath(script)))
    } else if (isTty(0)) {
      for (const file of await startupFiles({ home: shell.vars.get('HOME'), login: false, interactive: true }, startupHost)) {
        if (!await runStartupFile(file)) break
      }
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
