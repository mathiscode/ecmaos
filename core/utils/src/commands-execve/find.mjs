/**
 * Search a directory tree, as GNU `find` does: an expression of tests (`-name`, `-type`, `-size`, `-mtime`, `-perm`,
 * `-user`, `-newer`, `-regex`, `-empty`, ...), operators (`!`, `-a`, `-o`, `,` and parentheses) and actions (`-print`,
 * `-print0`, `-printf`, `-ls`, `-delete`, `-exec`, `-execdir`, `-ok`, `-prune`, `-quit`), evaluated for every file under
 * each starting point. With no action, `-print` is implied. `-L`, `-H` and `-P` choose how symlinks are followed.
 */

import { resolve, dirname, basename } from './lib/path-utils.mjs'
import { compile } from './lib/fnmatch.mjs'
import { translate, toBytes } from './lib/regex-posix.mjs'
import { parseDate } from './lib/datespec.mjs'
import { reasonOf, is } from './lib/errno.mjs'
import { findProgram, readAll, openDevNull, run } from './lib/run.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, read, getcwd, stat, lstat, readdir, readlink, unlink, rmdir, access, open, close, O_RDONLY } = sys

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const err = text => writeAll(2, encoder.encode(`find: ${text}\n`))

const S_IFMT = 0xf000
const TYPES = { 0x8000: 'f', 0x4000: 'd', 0xa000: 'l', 0x2000: 'c', 0x6000: 'b', 0x1000: 'p', 0xc000: 's' }
const typeOf = mode => TYPES[mode & S_IFMT] ?? 'f'

const usage = `Usage: find [-H] [-L] [-P] [path...] [expression]

Tests:   -name -iname -path -ipath -regex -iregex -type -xtype -size -empty -newer -newerXY -mtime -atime -ctime
         -mmin -amin -cmin -perm -user -group -uid -gid -nouser -nogroup -links -inum -readable -writable
         -executable -samefile -lname -ilname -true -false
Options: -maxdepth N -mindepth N -depth -mount -xdev -daystart -follow -regextype TYPE
Operators: ( EXPR ) ! EXPR -not EXPR EXPR -a EXPR EXPR -o EXPR EXPR , EXPR
Actions: -print -print0 -printf FORMAT -ls -delete -exec CMD ; -exec CMD {} + -execdir CMD ; -ok CMD ; -prune -quit

  --help  display this help and exit`

class Quit extends Error {}
class UsageError extends Error {}

let status = 0
const fail = text => { err(text); status = 1 }

// ---- output ---------------------------------------------------------------------------------------------------------
let buffered = []
let bufferedSize = 0
const emit = text => {
  buffered.push(text)
  bufferedSize += text.length
  if (bufferedSize > 32768) flush()
}
function flush() {
  if (buffered.length === 0) return
  const bytes = encoder.encode(buffered.join(''))
  buffered = []
  bufferedSize = 0
  writeAll(1, bytes)
}

// ---- users and groups ----------------------------------------------------------------------------------------------
let passwdCache, groupCache
const loadTable = path => {
  const table = []
  try {
    const fd = open(path, O_RDONLY)
    try {
      for (const line of decoder.decode(readAll(fd)).split('\n')) {
        const f = line.split(':')
        if (f.length >= 3 && /^\d+$/.test(f[2])) table.push({ name: f[0], id: Number(f[2]) })
      }
    } finally { close(fd) }
  } catch { /* none */ }
  return table
}
const users = () => (passwdCache ??= loadTable('/etc/passwd'))
const groups = () => (groupCache ??= loadTable('/etc/group'))
const userName = uid => users().find(u => u.id === uid)?.name ?? String(uid)
const groupName = gid => groups().find(g => g.id === gid)?.name ?? String(gid)

// ---- helpers --------------------------------------------------------------------------------------------------------
const symbolicMode = mode => {
  const t = typeOf(mode)
  let s = t === 'f' ? '-' : t
  const bits = [[0o400, 'r'], [0o200, 'w'], [0o100, 'x'], [0o040, 'r'], [0o020, 'w'], [0o010, 'x'], [0o004, 'r'], [0o002, 'w'], [0o001, 'x']]
  for (const [bit, ch] of bits) s += mode & bit ? ch : '-'
  const chars = s.split('')
  if (mode & 0o4000) chars[3] = mode & 0o100 ? 's' : 'S'
  if (mode & 0o2000) chars[6] = mode & 0o010 ? 's' : 'S'
  if (mode & 0o1000) chars[9] = mode & 0o001 ? 't' : 'T'
  return chars.join('')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const p2 = n => String(n).padStart(2, '0')
const fraction = ms => `${String(Math.floor((ms % 1000 + 1000) % 1000)).padStart(3, '0')}0000000`

/** One `%T`-style time directive (`@ Y m d H M S F T c A a B b h j p y Z z +`) for `ms` */
function timeField(ms, key) {
  const d = new Date(ms)
  switch (key) {
    case '@': return `${Math.floor(ms / 1000)}.${fraction(ms)}`
    case 'Y': return String(d.getFullYear())
    case 'y': return p2(d.getFullYear() % 100)
    case 'm': return p2(d.getMonth() + 1)
    case 'd': return p2(d.getDate())
    case 'e': return String(d.getDate()).padStart(2)
    case 'H': return p2(d.getHours())
    case 'I': return p2(d.getHours() % 12 || 12)
    case 'M': return p2(d.getMinutes())
    case 'S': return `${p2(d.getSeconds())}.${fraction(ms)}`
    case 's': return String(Math.floor(ms / 1000))
    case 'F': return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
    case 'T': return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    case 'R': return `${p2(d.getHours())}:${p2(d.getMinutes())}`
    case 'D': return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${p2(d.getFullYear() % 100)}`
    case 'a': return DAYS[d.getDay()]
    case 'A': return FULL_DAYS[d.getDay()]
    case 'b': case 'h': return MONTHS[d.getMonth()]
    case 'B': return FULL_MONTHS[d.getMonth()]
    case 'p': return d.getHours() < 12 ? 'AM' : 'PM'
    case 'j': return String(Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(d.getFullYear(), 0, 0)) / 86400000)).padStart(3, '0')
    case 'u': return String(d.getDay() || 7)
    case 'w': return String(d.getDay())
    case 'Z': return 'UTC'
    case 'z': { const o = -d.getTimezoneOffset(); return `${o < 0 ? '-' : '+'}${p2(Math.floor(Math.abs(o) / 60))}${p2(Math.abs(o) % 60)}` }
    case 'c': return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`
    case '+': return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}+${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${fraction(ms)}`
    case 'n': return '\n'
    case 't': return '\t'
    case '%': return '%'
    default: return undefined
  }
}
/** `%t`: the `ctime(3)` form with a fractional second, as `-printf %t` writes it */
const ctimeStyle = ms => { const d = new Date(ms); return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${fraction(ms)} ${d.getFullYear()}` }

// ---- parsing --------------------------------------------------------------------------------------------------------
const NUMBER = /^[+-]?\d+$/

/** `{ sign, n }` from `+5`, `-5`, `5` */
function numeric(text, predicate) {
  if (!NUMBER.test(text)) throw new UsageError(`invalid argument \`${text}' to \`${predicate}'`)
  const sign = text[0] === '+' ? '+' : text[0] === '-' ? '-' : ''
  return { sign, n: Math.abs(Number(text)) }
}
const compare = ({ sign, n }, value) => (sign === '+' ? value > n : sign === '-' ? value < n : value === n)

const SIZE_UNITS = { b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824, T: 1099511627776, P: 1125899906842624 }

/** `-perm` modes: octal or symbolic (`u=rwx,g+x`), as the bits they describe */
function permBits(text) {
  if (/^[0-7]+$/.test(text)) return parseInt(text, 8)
  let mode = 0
  for (const clause of text.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*|[ugo])$/.exec(clause)
    if (!m) throw new UsageError(`invalid mode \`${text}'`)
    const [, who, op, perms] = m
    const targets = who === '' || who.includes('a') ? 'ugo' : who
    let bits = 0
    for (const t of targets) {
      const shift = t === 'u' ? 6 : t === 'g' ? 3 : 0
      for (const p of perms) {
        if (p === 'r') bits |= 4 << shift
        else if (p === 'w') bits |= 2 << shift
        else if (p === 'x' || p === 'X') bits |= 1 << shift
        else if (p === 's' && t === 'u') bits |= 0o4000
        else if (p === 's' && t === 'g') bits |= 0o2000
        else if (p === 't') bits |= 0o1000
      }
    }
    if (op === '+') mode |= bits
    else if (op === '-') mode &= ~bits
    else {
      let mask = 0
      for (const t of targets) mask |= 7 << (t === 'u' ? 6 : t === 'g' ? 3 : 0)
      mode = (mode & ~mask) | bits
    }
  }
  return mode
}

/** Translates the emacs-style regex `find` uses by default (`+` and `?` are operators, `\(` `\)` `\|` group) to POSIX basic */
function emacsToBasic(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') { out += c + (pattern[i + 1] ?? ''); i++ }
    else if (c === '[') {
      let j = i + 1
      if (pattern[j] === '^') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      out += pattern.slice(i, j + 1)
      i = j
    } else if (c === '+' || c === '?') out += '\\' + c
    else out += c
  }
  return out
}

const REGEX_TYPES = ['findutils-default', 'awk', 'ed', 'egrep', 'emacs', 'gnu-awk', 'grep', 'posix-awk', 'posix-basic', 'posix-egrep', 'posix-extended', 'posix-minimal-basic', 'sed']

/** A name as `-ls` writes it: backslashes, blanks and control characters escaped as C does */
function escapeName(name) {
  return name.replace(/[\\ \x00-\x1f\x7f]/g, c => ({ '\\': '\\\\', ' ': '\\ ', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\f': '\\f', '\v': '\\v' })[c] ?? '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))
}

/**
 * Parses the expression in `args` into a function of a file context. `settings` collects the global options
 * (`-maxdepth`, `-depth`, ...); `state` records what the expression contains.
 */
function parseExpression(args, settings, cwd, now, start) {
  let pos = 0
  const state = { hasAction: false, usesDelete: false, batches: new Map() }
  const next = name => {
    if (pos >= args.length) throw new UsageError(`missing argument to \`${name}'`)
    return args[pos++]
  }
  const intArg = name => {
    const text = next(name)
    if (!/^\d+$/.test(text)) throw new UsageError(`Expected a positive decimal integer argument to ${name}, but got '${text}'`)
    return Number(text)
  }
  const stampOf = path => {
    try { return (settings.follow === 'L' ? stat : stat)(resolve(cwd, path)) } catch (error) { throw new UsageError(`'${path}': ${reasonOf(error)}`) }
  }

  /** A test on the context's stats */
  const stat_ = test => ({ eval: ctx => test(ctx.stats, ctx) })

  function actionExec(name, single) {
    state.hasAction = true
    const exec = []
    for (;;) {
      if (pos >= args.length) throw new UsageError(`missing argument to \`${name}'`)
      const token = args[pos++]
      if (token === ';') { var plus = false; break }
      if (token === '+' && exec[exec.length - 1] === '{}') { plus = true; break }
      exec.push(token)
    }
    if (exec.length === 0) throw new UsageError(`missing argument to \`${name}'`)
    const inDir = name === '-execdir' || name === '-okdir'
    const ask = name === '-ok' || name === '-okdir'
    if (plus) {
      if (ask) throw new UsageError(`missing argument to \`${name}'`)
      const prefix = exec.slice(0, -1)
      return {
        eval: ctx => {
          const key = inDir ? ctx.dirFull : ''
          let batch = state.batches.get(key)
          if (!batch) { batch = { prefix, files: [], cwd: inDir ? ctx.dirFull : cwd, size: 0 }; state.batches.set(key, batch) }
          const file = inDir ? `./${ctx.name}` : ctx.display
          batch.files.push(file)
          batch.size += file.length + 1
          if (batch.size > 120000) { flush(); runBatch(batch); state.batches.delete(key) }
          return true
        }
      }
    }
    return {
      eval: async ctx => {
        const file = inDir ? `./${ctx.name}` : ctx.display
        const command = exec.map(a => a.split('{}').join(file))
        if (ask) {
          writeAll(2, encoder.encode(`< ${command.join(' ')} ... ${file} > ? `))
          const byte = new Uint8Array(1)
          let line = ''
          for (;;) { if (read(0, byte, -1) <= 0 || byte[0] === 10) break; line += String.fromCharCode(byte[0]) }
          if (!/^y/i.test(line)) return false
        }
        flush()
        const program = findProgram(command[0])
        if (!program) { fail(`'${command[0]}': No such file or directory`); return false }
        const { status: code } = await run(program, command, { cwd: inDir ? ctx.dirFull : cwd })
        return code === 0
      }
    }
  }

  async function runBatch(batch) {
    if (batch.files.length === 0) return
    const command = [...batch.prefix, ...batch.files]
    const program = findProgram(command[0])
    if (!program) { fail(`'${command[0]}': No such file or directory`); return }
    flush()
    const devNull = openDevNull()
    const { status: code } = await run(program, command, { cwd: batch.cwd, fds: { 0: devNull, 1: 1, 2: 2 } })
    close(devNull)
    if (code !== 0) status = 1
    batch.files = []
    batch.size = 0
  }
  state.flushBatches = async () => {
    for (const batch of state.batches.values()) await runBatch(batch)
    state.batches.clear()
  }

  function printf(format) {
    // Validated up front, as GNU does: a lone % at the end is an error
    if (/(^|[^%])(%%)*%$/.test(format.replace(/\\./g, 'xx'))) throw new UsageError('error: % at end of format string')
    return ctx => {
      let out = ''
      for (let i = 0; i < format.length; i++) {
        const c = format[i]
        if (c === '\\') {
          const n = format[++i]
          if (n === undefined) { out += '\\'; break }
          if (n === 'n') out += '\n'
          else if (n === 't') out += '\t'
          else if (n === 'r') out += '\r'
          else if (n === 'a') out += '\x07'
          else if (n === 'b') out += '\b'
          else if (n === 'f') out += '\f'
          else if (n === 'v') out += '\v'
          else if (n === '\\') out += '\\'
          else if (n === 'c') return out
          else if (/[0-7]/.test(n)) {
            let oct = n
            while (oct.length < 3 && /[0-7]/.test(format[i + 1] ?? '')) oct += format[++i]
            out += String.fromCharCode(parseInt(oct, 8))
          } else out += '\\' + n
          continue
        }
        if (c !== '%') { out += c; continue }
        let flags = ''
        let j = i + 1
        while (/[-+ #0]/.test(format[j] ?? '')) flags += format[j++]
        let width = ''
        while (/\d/.test(format[j] ?? '')) width += format[j++]
        let precision
        if (format[j] === '.') { j++; precision = ''; while (/\d/.test(format[j] ?? '')) precision += format[j++] }
        const key = format[j]
        const pad = value => {
          let text = String(value)
          if (precision !== undefined && precision !== '' && /^[spPfhHF]$/.test(key)) text = text.slice(0, Number(precision))
          if (width) text = flags.includes('-') ? text.padEnd(Number(width)) : text.padStart(Number(width), flags.includes('0') && /^[sdkbnimuUgGM]$/.test(key) ? '0' : ' ')
          return text
        }
        const s = ctx.stats
        let value
        switch (key) {
          case '%': value = '%'; break
          case 'p': value = ctx.display; break
          case 'f': value = ctx.name; break
          case 'h': value = ctx.display.includes('/') ? (ctx.display.replace(/\/+$/, '').slice(0, ctx.display.replace(/\/+$/, '').lastIndexOf('/')) || '/') : '.'; break
          case 'H': value = ctx.startDisplay; break
          case 'P': value = ctx.depth === 0 ? '' : ctx.display.slice(ctx.startDisplay.length).replace(/^\/+/, ''); break
          case 's': value = s.size; break
          case 'S': value = s.size === 0 ? '0' : String(Math.round(((s.blocks ?? Math.ceil(s.size / 512)) * 512 / s.size) * 1000) / 1000); break
          case 'k': value = Math.ceil((s.blocks ?? Math.ceil(s.size / 512)) / 2); break
          case 'b': value = s.blocks ?? Math.ceil(s.size / 512); break
          case 'm': value = (s.mode & 0o7777).toString(8); break
          case 'M': value = symbolicMode(s.mode); break
          case 'u': value = userName(s.uid); break
          case 'U': value = s.uid; break
          case 'g': value = groupName(s.gid); break
          case 'G': value = s.gid; break
          case 'n': value = s.nlink ?? 1; break
          case 'i': value = s.ino ?? 0; break
          case 'D': value = String(s.dev ?? 0); break
          case 'd': value = ctx.depth; break
          case 'y': value = typeOf(s.mode); break
          case 'Y': { try { value = typeOf(stat(ctx.full).mode) } catch { value = typeOf(s.mode) === 'l' ? 'N' : typeOf(s.mode) } break }
          case 'l': { value = ''; if (typeOf(s.mode) === 'l') { try { value = readlink(ctx.full) } catch { /* shown empty */ } } break }
          case 't': value = ctimeStyle(s.mtimeMs); break
          case 'a': value = ctimeStyle(s.atimeMs); break
          case 'c': value = ctimeStyle(s.ctimeMs ?? s.mtimeMs); break
          case 'A': case 'C': case 'T': {
            const field = format[++j]
            const ms = key === 'A' ? s.atimeMs : key === 'C' ? (s.ctimeMs ?? s.mtimeMs) : s.mtimeMs
            const text = field === undefined ? undefined : timeField(ms, field)
            if (text === undefined) { out += `%${key}${field ?? ''}`; i = j; continue }
            out += pad(text)
            i = j
            continue
          }
          default:
            err(`warning: unrecognized format directive \`%${key ?? ''}'`)
            out += '%' + (key ?? '')
            i = j
            continue
        }
        out += pad(value)
        i = j
      }
      return out
    }
  }

  // ---- grammar: comma < or < and < not < primary ----
  function parseComma() {
    let left = parseOr()
    while (args[pos] === ',') {
      pos++
      const right = parseOr()
      const l = left
      left = { eval: async ctx => { await l.eval(ctx); return right.eval(ctx) } }
    }
    return left
  }
  function parseOr() {
    let left = parseAnd()
    while (args[pos] === '-o' || args[pos] === '-or') {
      pos++
      if (pos >= args.length) throw new UsageError("expected an expression after '-o'")
      const right = parseAnd()
      const l = left
      left = { eval: async ctx => (await l.eval(ctx)) || right.eval(ctx) }
    }
    return left
  }
  function parseAnd() {
    let left = parseNot()
    for (;;) {
      const token = args[pos]
      if (token === undefined || token === '-o' || token === '-or' || token === ')' || token === ',') return left
      if (token === '-a' || token === '-and') {
        pos++
        if (pos >= args.length) throw new UsageError("expected an expression after '-a'")
      }
      const right = parseNot()
      const l = left
      left = { eval: async ctx => (await l.eval(ctx)) && right.eval(ctx) }
    }
  }
  function parseNot() {
    const token = args[pos]
    if (token === '!' || token === '-not') {
      pos++
      if (pos >= args.length || args[pos] === ')') throw new UsageError(`expected an expression after '${token}'`)
      const inner = parseNot()
      return { eval: async ctx => !(await inner.eval(ctx)) }
    }
    return parsePrimary()
  }
  function parsePrimary() {
    const token = args[pos++]
    if (token === '(') {
      if (args[pos] === ')') throw new UsageError('invalid expression; empty parentheses are not allowed.')
      const inner = parseComma()
      if (args[pos] !== ')') throw new UsageError("invalid expression; I was expecting to find a ')' somewhere but did not see one.")
      pos++
      return inner
    }
    if (token === ')') throw new UsageError('you have too many \')\'')
    if (token === undefined) throw new UsageError('invalid expression')
    if (!token.startsWith('-')) throw new UsageError(`paths must precede expression: \`${token}'`)
    const simple = { eval: () => true }

    switch (token) {
      // ---- global options (always true) ----
      case '-maxdepth': settings.maxdepth = intArg(token); return simple
      case '-mindepth': settings.mindepth = intArg(token); return simple
      case '-depth': case '-d': settings.depthFirst = true; return simple
      case '-mount': case '-xdev': case '-noleaf': case '-ignore_readdir_race': case '-noignore_readdir_race': case '-warn': case '-nowarn': return simple
      case '-follow': settings.follow = 'L'; return simple
      case '-daystart': { const d = new Date(now); settings.now = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); return simple }
      case '-regextype': {
        const type = next(token)
        if (!REGEX_TYPES.includes(type)) throw new UsageError(`Unknown regular expression type '${type}'; valid types are ${REGEX_TYPES.map(t => `'${t}'`).join(', ')}.`)
        settings.regextype = type
        return simple
      }
      case '-true': return simple
      case '-false': return { eval: () => false }

      // ---- name tests ----
      case '-name': case '-iname': {
        const match = compile(next(token), { caseFold: token === '-iname' })
        return { eval: ctx => match(ctx.name) }
      }
      case '-path': case '-wholename': case '-ipath': case '-iwholename': {
        const match = compile(next(token), { caseFold: token[1] === 'i' })
        return { eval: ctx => match(ctx.display) }
      }
      case '-lname': case '-ilname': {
        const match = compile(next(token), { caseFold: token === '-ilname' })
        return stat_((s, ctx) => { if (typeOf(s.mode) !== 'l') return false; try { return match(readlink(ctx.full)) } catch { return false } })
      }
      case '-regex': case '-iregex': {
        const pattern = next(token)
        const type = settings.regextype ?? 'findutils-default'
        let source
        try {
          const text = type === 'emacs' || type === 'findutils-default' ? emacsToBasic(pattern) : pattern
          source = translate(toBytes(text), /extended|egrep|awk/.test(type)).source
        } catch (error) {
          throw new UsageError(`Invalid regular expression \`${pattern}': ${error.message}`)
        }
        const re = new RegExp(`^(?:${source})$`, token === '-iregex' ? 'is' : 's')
        return { eval: ctx => re.test(toBytes(ctx.display)) }
      }

      // ---- type, size, emptiness ----
      case '-type': case '-xtype': {
        const text = next(token)
        const letters = text.split(',')
        for (const l of letters) if (!/^[bcdpflsD]$/.test(l)) throw new UsageError(text.includes(',') ? `Must separate multiple arguments to -type using: ','` : `Unknown argument to ${token}: ${l}`)
        if (token === '-xtype') {
          return stat_((s, ctx) => { let m = s.mode; if (typeOf(m) === 'l') { try { m = stat(ctx.full).mode } catch { /* dangling stays l */ } } return letters.includes(typeOf(m)) })
        }
        return stat_(s => letters.includes(typeOf(s.mode)))
      }
      case '-size': {
        const text = next(token)
        const m = /^([+-]?)(\d+)(.?)$/.exec(text)
        if (!m) throw new UsageError(`invalid argument \`${text}' to \`-size'`)
        const unit = m[3] === '' ? 'b' : m[3]
        if (!(unit in SIZE_UNITS)) throw new UsageError(`invalid -size type \`${m[3]}'`)
        const spec = { sign: m[1], n: Number(m[2]) }
        return stat_(s => compare(spec, Math.ceil(s.size / SIZE_UNITS[unit])))
      }
      case '-empty':
        return stat_((s, ctx) => {
          const t = typeOf(s.mode)
          if (t === 'f') return s.size === 0
          if (t === 'd') { try { return readdir(ctx.full).length === 0 } catch { return false } }
          return false
        })

      // ---- times ----
      case '-newer': case '-anewer': case '-cnewer': {
        const ref = stampOf(next(token))
        const key = token === '-newer' ? 'mtimeMs' : token === '-anewer' ? 'atimeMs' : 'ctimeMs'
        return stat_(s => (s[key] ?? s.mtimeMs) > ref.mtimeMs)
      }
      case '-mtime': case '-atime': case '-ctime': case '-mmin': case '-amin': case '-cmin': {
        const spec = numeric(next(token), token)
        const key = token[1] === 'm' ? 'mtimeMs' : token[1] === 'a' ? 'atimeMs' : 'ctimeMs'
        const window = token.endsWith('min') ? 60000 : 86400000
        return stat_(s => compare(spec, Math.floor(((settings.now ?? now) - (s[key] ?? s.mtimeMs)) / window)))
      }
      case '-used': {
        const spec = numeric(next(token), token)
        return stat_(s => compare(spec, Math.floor(((s.atimeMs ?? 0) - (s.ctimeMs ?? s.mtimeMs)) / 86400000)))
      }

      // ---- ownership, permissions, links ----
      case '-perm': {
        const text = next(token)
        const mode = text[0] === '-' || text[0] === '/' ? text.slice(1) : text
        const want = permBits(mode)
        if (text[0] === '-') return stat_(s => (s.mode & 0o7777 & want) === want)
        if (text[0] === '/') return stat_(s => want === 0 || (s.mode & 0o7777 & want) !== 0)
        return stat_(s => (s.mode & 0o7777) === want)
      }
      case '-user': case '-group': {
        const name = next(token)
        const table = token === '-user' ? users() : groups()
        let id = table.find(e => e.name === name)?.id
        if (id === undefined && /^\d+$/.test(name)) id = Number(name)
        if (id === undefined) throw new UsageError(token === '-user' ? `invalid user name or UID argument to -user: '${name}'` : `'${name}' is not the name of an existing group`)
        const key = token === '-user' ? 'uid' : 'gid'
        return stat_(s => s[key] === id)
      }
      case '-uid': case '-gid': {
        const spec = numeric(next(token), token)
        const key = token === '-uid' ? 'uid' : 'gid'
        return stat_(s => compare(spec, s[key]))
      }
      case '-nouser': return stat_(s => !users().some(u => u.id === s.uid))
      case '-nogroup': return stat_(s => !groups().some(g => g.id === s.gid))
      case '-links': { const spec = numeric(next(token), token); return stat_(s => compare(spec, s.nlink ?? 1)) }
      case '-inum': { const spec = numeric(next(token), token); return stat_(s => compare(spec, s.ino ?? 0)) }
      case '-samefile': {
        const ref = stampOf(next(token))
        return stat_(s => s.ino === ref.ino && String(s.dev) === String(ref.dev))
      }
      case '-readable': case '-writable': case '-executable': {
        const bit = token === '-readable' ? 4 : token === '-writable' ? 2 : 1
        return stat_((s, ctx) => { try { access(ctx.full, bit); return true } catch { return false } })
      }

      // ---- actions ----
      case '-print': state.hasAction = true; return { eval: ctx => { emit(ctx.display + '\n'); return true } }
      case '-print0': state.hasAction = true; return { eval: ctx => { emit(ctx.display + '\0'); return true } }
      case '-printf': { state.hasAction = true; const f = printf(next(token)); return { eval: ctx => { emit(f(ctx)); return true } } }
      case '-ls': {
        state.hasAction = true
        return {
          eval: ctx => {
            const s = ctx.stats
            // whole 4 KiB blocks shown in 1 KiB units; a symlink or directory takes none, as `du` counts
            const kind = typeOf(s.mode)
            const blocks = kind === 'l' || kind === 'd' ? 0 : 4 * Math.ceil(s.size / 4096)
            const d = new Date(s.mtimeMs)
            const old = Math.abs((settings.now ?? now) - s.mtimeMs) > 15778476000
            const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${old ? ` ${d.getFullYear()}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`}`
            let name = escapeName(ctx.display)
            if (kind === 'l') { try { name += ` -> ${escapeName(readlink(ctx.full))}` } catch { /* no target shown */ } }
            emit(`${String(s.ino ?? 0).padStart(6)} ${String(blocks).padStart(4)} ${symbolicMode(s.mode)} ${String(s.nlink ?? 1).padStart(3)} ${userName(s.uid).padEnd(8)} ${groupName(s.gid).padEnd(8)} ${String(s.size).padStart(8)} ${when} ${name}\n`)
            return true
          }
        }
      }
      case '-delete':
        state.hasAction = true
        state.usesDelete = true
        settings.depthFirst = true
        return {
          eval: ctx => {
            // The starting point "." is never removed
            if (ctx.display === '.') return true
            try {
              if (typeOf(ctx.stats.mode) === 'd') rmdir(ctx.full)
              else unlink(ctx.full)
              return true
            } catch (error) {
              fail(`cannot delete '${ctx.display}': ${reasonOf(error)}`)
              return false
            }
          }
        }
      case '-exec': case '-execdir': case '-ok': case '-okdir': return actionExec(token)
      case '-prune': return { eval: ctx => { ctx.pruned = true; return true } }
      case '-quit': return { eval: () => { throw new Quit() } }
      case '-fprint': case '-fprint0': case '-fprintf': case '-fls': throw new UsageError(`unsupported action \`${token}'`)
    }

    // -newerXY REF
    const newer = /^-newer([acBm])([acBmt])$/.exec(token)
    if (newer) {
      const [, x, y] = newer
      const arg = next(token)
      let ref
      if (y === 't') {
        ref = parseDate(arg, now)
        if (Number.isNaN(ref)) throw new UsageError(`I cannot figure out how to interpret \`${arg}' as a date or time`)
      } else {
        const s = stampOf(arg)
        ref = (y === 'a' ? s.atimeMs : y === 'c' ? s.ctimeMs : s.mtimeMs) ?? s.mtimeMs
      }
      const key = x === 'a' ? 'atimeMs' : x === 'c' ? 'ctimeMs' : 'mtimeMs'
      return stat_(s => (s[key] ?? s.mtimeMs) > ref)
    }
    throw new UsageError(`unknown predicate \`${token}'`)
  }

  if (args.length === 0) return { expr: { eval: ctx => { emit(ctx.display + '\n'); return true } }, state }
  const expr = parseComma()
  if (pos < args.length) throw new UsageError(args[pos] === ')' ? "you have too many ')'" : `unexpected extra predicate \`${args[pos]}'`)
  if (!state.hasAction) {
    const e = expr
    return { expr: { eval: async ctx => { if (await e.eval(ctx)) emit(ctx.display + '\n'); return true } }, state }
  }
  return { expr, state }
}

// ---- main -----------------------------------------------------------------------------------------------------------
async function main() {
  const args = argv.slice(1)
  if (args.includes('--help') && args.indexOf('--help') === 0) { writeAll(1, encoder.encode(usage + '\n')); return 0 }
  if (args[0] === '--version') { writeAll(1, encoder.encode('find (ecmaOS coreutils)\n')); return 0 }

  const settings = { follow: 'P' }
  let i = 0
  while (i < args.length && (args[i] === '-H' || args[i] === '-L' || args[i] === '-P')) settings.follow = args[i++][1]
  const paths = []
  while (i < args.length && !(args[i].startsWith('-') || args[i] === '(' || args[i] === '!' || args[i] === ',')) paths.push(args[i++])
  if (paths.length === 0) paths.push('.')

  const cwd = getcwd()
  const now = Date.now()
  let parsed
  try {
    parsed = parseExpression(args.slice(i), settings, cwd, now, paths)
  } catch (error) {
    if (error instanceof UsageError) { err(error.message); return 1 }
    throw error
  }
  const { expr, state } = parsed
  const maxdepth = settings.maxdepth ?? Infinity
  const mindepth = settings.mindepth ?? 0

  const statOf = (full, depth) => {
    const follow = settings.follow === 'L' || (settings.follow === 'H' && depth === 0)
    if (follow) { try { return stat(full) } catch { /* a dangling link is described itself */ } }
    return lstat(full)
  }

  const visit = async (display, full, depth, startDisplay, ancestors) => {
    let stats
    try { stats = statOf(full, depth) } catch (error) {
      fail(`'${display}': ${reasonOf(error)}`)
      return
    }
    const name = depth === 0 ? (basename(display) || '/') : display.slice(display.lastIndexOf('/') + 1)
    const ctx = { display, full, name, depth, stats, startDisplay, pruned: false, dirFull: dirname(full) }
    const isDir = typeOf(stats.mode) === 'd'
    if (!settings.depthFirst && depth >= mindepth) await expr.eval(ctx)
    if (isDir && depth < maxdepth && !ctx.pruned) {
      const key = `${stats.dev}:${stats.ino}`
      if (settings.follow !== 'P' && ancestors.has(key)) {
        fail(`File system loop detected; '${display}' is part of the same file system loop as '${ancestors.get(key)}'.`)
      } else {
        let names
        try { names = readdir(full) } catch (error) { fail(`'${display}': ${reasonOf(error)}`); names = [] }
        const nextAncestors = new Map(ancestors).set(key, display)
        for (const name of names) {
          await visit(display.endsWith('/') ? display + name : `${display}/${name}`, full === '/' ? `/${name}` : `${full}/${name}`, depth + 1, startDisplay, nextAncestors)
        }
      }
    }
    if (settings.depthFirst && depth >= mindepth) await expr.eval(ctx)
  }

  try {
    for (const path of paths) await visit(path, resolve(cwd, path), 0, path, new Map())
  } catch (error) {
    if (!(error instanceof Quit)) throw error
  }
  await state.flushBatches()
  flush()
  return status
}

try {
  exit(await main())
} catch (error) {
  flush()
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
