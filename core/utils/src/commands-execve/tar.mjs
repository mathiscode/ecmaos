/**
 * `tar`: create, list, extract, append to, update and delete from tar archives, as GNU tar does. Headers are written byte for
 * byte as GNU writes them (`gnu` by default; `ustar`, `posix` and `v7` with `--format`), an archive is padded to full records, a
 * name too long for a header goes in a long-name member, and archives can be compressed: gzip in place (`-z`), and bzip2, xz,
 * lzma and zstd (`-j`, `-J`, `--lzma`, `--zstd`) or any program (`-I`) through the program of that name, run as a filter; `-a`
 * picks one by the archive's name, and a compressed archive is recognized when read. Options after a file name are positional,
 * as in GNU tar: `--exclude` and `-C` apply to the names that follow them.
 */

import { compile as compilePattern } from './lib/fnmatch.mjs'
import { readFdBytes, readFileBytes, writeFdBytes } from './lib/bytes.mjs'
import { reasonOf } from './lib/errno.mjs'
import { chmodOwned, chownOwned, utimesOwned } from './lib/owner-ops.mjs'
import { resolve } from './lib/path-utils.mjs'
import { findProgram, readAll, statusOf, waitFor } from './lib/run.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, getcwd, open, close, stat, lstat, readdir, mkdir, unlink, rmdir, symlink, link, readlink, getuid, getpid, pipe, spawn, env, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = sys

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// - output ---------------------------------------------------------------------------------------------------------

const outParts = []
const out = text => { outParts.push(text); if (outParts.length > 256) flushOut() }
const flushOut = () => {
  if (outParts.length === 0) return
  const bytes = encoder.encode(outParts.join(''))
  outParts.length = 0
  writeFdBytes(1, bytes)
}
let failures = 0
const err = text => { flushOut(); writeFdBytes(2, encoder.encode(`tar: ${text}\n`)) }
const fail = text => { failures++; err(text) }

class Usage extends Error { constructor(message, status = 64) { super(message); this.status = status } }
class Fatal extends Error { constructor(message, status = 2, extra) { super(message); this.status = status; this.extra = extra } }

const HELP_HINT = "Try 'tar --help' or 'tar --usage' for more information."

const usage = `Usage: tar [OPTION...] [FILE]...
GNU 'tar' saves many files together into a single tape or disk archive, and can restore individual files from the archive.

 Main operation mode:
  -A, --catenate, --concatenate   append tar files to an archive
  -c, --create               create a new archive
      --delete               delete from the archive
  -r, --append               append files to the end of an archive
  -t, --list                 list the contents of an archive
  -u, --update               only append files newer than copy in archive
  -x, --extract, --get       extract files from an archive

 Device selection and switching:
  -f, --file=ARCHIVE         use archive file or device ARCHIVE

 Compression options:
  -a, --auto-compress        use archive suffix to determine the compression program
  -I, --use-compress-program=PROG   filter through PROG (must accept -d)
  -j, --bzip2                filter the archive through bzip2
  -J, --xz                   filter the archive through xz
      --lzma                 filter the archive through xz --format=lzma
  -z, --gzip, --gunzip, --ungzip   filter the archive through gzip
      --zstd                 filter the archive through zstd

 Local file selection:
  -C, --directory=DIR        change to directory DIR
      --exclude=PATTERN      exclude files, given as a PATTERN
  -T, --files-from=FILE      get names to extract or create from FILE
      --strip-components=NUMBER   strip NUMBER leading components from file names on extraction
  -h, --dereference          follow symlinks; archive and dump the files they point to

 Informative output:
  -v, --verbose              verbosely list files processed

  -?, --help                 give this help list
      --usage                give a short usage message`

const BLOCK = 512

// - archive entries --------------------------------------------------------------------------------------------------

const TYPES = { file: '0', hardlink: '1', symlink: '2', char: '3', block: '4', dir: '5', fifo: '6' }

function readString(bytes, offset, length) {
  let end = offset
  const limit = offset + length
  while (end < limit && bytes[end] !== 0) end++
  return decoder.decode(bytes.subarray(offset, end))
}

function readOctal(bytes, offset, length) {
  if (bytes[offset] & 0x80) {
    // base-256 numbers, for sizes and times too big for octal
    let value = bytes[offset] & 0x7f
    for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]
    return value
  }
  const text = readString(bytes, offset, length).trim()
  return text === '' ? 0 : parseInt(text, 8)
}

function checksumOf(block) {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]
  return sum
}

const isZero = block => { for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false; return true }

/** `{ key: value }` of a pax extended header body (`LEN key=value\n` records) */
function parsePax(bytes) {
  const fields = {}
  let at = 0
  while (at < bytes.length) {
    let space = at
    while (space < bytes.length && bytes[space] !== 0x20) space++
    const length = parseInt(decoder.decode(bytes.subarray(at, space)), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1))
    const eq = record.indexOf('=')
    if (eq > 0) fields[record.slice(0, eq)] = record.slice(eq + 1)
    at += length
  }
  return fields
}

/**
 * The members of an archive as `{ name, mode, uid, gid, size, mtime, type, linkname, uname, gname, data, raw }`; `raw` is the bytes
 * of the member as stored (extension headers included), so an archive can be rewritten without disturbing what it holds.
 * `{ entries, problem }`: `problem` is set when the archive ends badly.
 */
function parseArchive(bytes) {
  const entries = []
  let at = 0
  let longName
  let longLink
  let pax = {}
  let rawStart = 0
  let problem
  let sawEnd = false
  while (at + BLOCK <= bytes.length) {
    const block = bytes.subarray(at, at + BLOCK)
    if (isZero(block)) { sawEnd = true; break }
    const stored = readOctal(block, 148, 8)
    if (stored !== checksumOf(block)) {
      problem = entries.length === 0 && at === 0 ? 'This does not look like a tar archive' : 'Skipping to next header'
      if (at === 0) break
      at += BLOCK
      continue
    }
    const typeByte = block[156]
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte)
    let size = readOctal(block, 124, 12)
    const dataStart = at + BLOCK
    const padded = Math.ceil(size / BLOCK) * BLOCK
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (dataStart + size > bytes.length) { problem = 'Unexpected EOF in archive'; break }
      const body = bytes.subarray(dataStart, dataStart + size)
      if (type === 'L') longName = readString(body, 0, body.length)
      else if (type === 'K') longLink = readString(body, 0, body.length)
      else if (type === 'x') pax = { ...pax, ...parsePax(body) }
      at = dataStart + padded
      continue
    }
    const magic = readString(block, 257, 6)
    let name = readString(block, 0, 100)
    if (magic === 'ustar') { const prefix = readString(block, 345, 155); if (prefix) name = `${prefix}/${name}` }
    if (longName !== undefined) name = longName
    if (pax.path !== undefined) name = pax.path
    let linkname = readString(block, 157, 100)
    if (longLink !== undefined) linkname = longLink
    if (pax.linkpath !== undefined) linkname = pax.linkpath
    if (pax.size !== undefined) size = Number(pax.size)
    const dataEnd = dataStart + size
    if ((type === '0' || type === '7') && dataEnd > bytes.length) { problem = 'Unexpected EOF in archive'; at = bytes.length; break }
    const hasData = type === '0' || type === '7'
    const stop = hasData ? dataStart + Math.ceil(size / BLOCK) * BLOCK : dataStart
    entries.push({
      name: type === '5' && !name.endsWith('/') ? name + '/' : name,
      mode: readOctal(block, 100, 8),
      uid: pax.uid !== undefined ? Number(pax.uid) : readOctal(block, 108, 8),
      gid: pax.gid !== undefined ? Number(pax.gid) : readOctal(block, 116, 8),
      size: hasData ? size : 0,
      mtime: pax.mtime !== undefined ? Math.floor(Number(pax.mtime)) : readOctal(block, 136, 12),
      type: type === '7' ? '0' : type,
      linkname,
      uname: pax.uname ?? readString(block, 265, 32),
      gname: pax.gname ?? readString(block, 297, 32),
      data: hasData ? bytes.subarray(dataStart, dataStart + size) : new Uint8Array(),
      raw: bytes.subarray(rawStart === at ? at : rawStart, Math.min(stop, bytes.length))
    })
    longName = undefined
    longLink = undefined
    pax = {}
    at = stop
    rawStart = at
  }
  if (!sawEnd && !problem && at < bytes.length) problem = 'Unexpected EOF in archive'
  if (bytes.length === 0) problem = 'This does not look like a tar archive'
  return { entries, problem }
}

// - building -------------------------------------------------------------------------------------------------------------

function setString(block, offset, length, text) {
  const bytes = encoder.encode(text)
  block.set(bytes.subarray(0, length), offset)
}

function setOctal(block, offset, length, value) {
  const digits = Math.max(0, Math.floor(value)).toString(8)
  if (digits.length > length - 1) {
    // too big for octal: GNU switches to base 256
    block[offset] = 0x80
    let rest = Math.floor(value)
    for (let i = length - 1; i >= 1; i--) { block[offset + i] = rest % 256; rest = Math.floor(rest / 256) }
    return
  }
  setString(block, offset, length, digits.padStart(length - 1, '0'))
}

/** An extension member (`L`, `K` or a pax `x` header) holding `payload` */
function extensionMember(typeflag, nameField, payload, format) {
  const block = new Uint8Array(BLOCK)
  setString(block, 0, 100, nameField)
  setOctal(block, 100, 8, 0o644)
  setOctal(block, 108, 8, 0)
  setOctal(block, 116, 8, 0)
  setOctal(block, 124, 12, payload.length)
  setOctal(block, 136, 12, 0)
  block[156] = typeflag.charCodeAt(0)
  finishHeader(block, format)
  const padded = new Uint8Array(Math.ceil(payload.length / BLOCK) * BLOCK)
  padded.set(payload)
  return [block, padded]
}

function finishHeader(block, format) {
  if (format === 'gnu') { setString(block, 257, 8, 'ustar  ') }
  else if (format !== 'v7') { setString(block, 257, 6, 'ustar'); setString(block, 263, 2, '00') }
  block.fill(32, 148, 156)
  const sum = checksumOf(block)
  setString(block, 148, 8, sum.toString(8).padStart(6, '0'))
  block[154] = 0
  block[155] = 32
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = encoder.encode(body).length
  let digits = String(length).length
  while (String(length + digits).length > digits) digits++
  length += digits
  return `${length}${body}`
}

/** The blocks of one member: its header (with whatever extension it needs) and its data, padded */
function memberBlocks(entry, format) {
  const blocks = []
  let name = entry.name
  let linkname = entry.linkname ?? ''
  const nameBytes = encoder.encode(name).length
  const linkBytes = encoder.encode(linkname).length
  let prefix = ''
  if (format === 'gnu') {
    if (nameBytes > 100) blocks.push(...extensionMember('L', '././@LongLink', encoder.encode(name + '\0'), format))
    if (linkBytes > 100) blocks.push(...extensionMember('K', '././@LongLink', encoder.encode(linkname + '\0'), format))
  } else if (format === 'posix') {
    const records = (nameBytes > 100 ? paxRecord('path', name) : '') + (linkBytes > 100 ? paxRecord('linkpath', linkname) : '') + (entry.size >= 8 ** 11 ? paxRecord('size', entry.size) : '')
    if (records) blocks.push(...extensionMember('x', `./PaxHeaders.0/${name.split('/').pop()}`.slice(0, 100), encoder.encode(records), format))
  } else if (format === 'ustar' && nameBytes > 100) {
    // the name splits at a slash into a prefix of at most 155 and a name of at most 100
    const at = name.slice(0, name.length - 1).lastIndexOf('/', 155)
    let split = -1
    for (let i = name.length - 1; i > 0; i--) if (name[i] === '/' && i <= 155 && name.length - i - 1 <= 100 && name.length - i - 1 > 0) { split = i; break }
    void at
    if (split < 0) throw new Fatal(`${name}: file name is too long (max 100); not dumped`)
    prefix = name.slice(0, split)
    name = name.slice(split + 1)
  }
  const block = new Uint8Array(BLOCK)
  setString(block, 0, 100, name)
  setOctal(block, 100, 8, entry.mode & 0o7777)
  setOctal(block, 108, 8, entry.uid)
  setOctal(block, 116, 8, entry.gid)
  setOctal(block, 124, 12, entry.type === '0' ? entry.size : 0)
  setOctal(block, 136, 12, entry.mtime)
  block[156] = (entry.type ?? '0').charCodeAt(0)
  setString(block, 157, 100, linkname)
  if (format !== 'v7') {
    setString(block, 265, 32, entry.uname ?? '')
    setString(block, 297, 32, entry.gname ?? '')
    if (prefix) setString(block, 345, 155, prefix)
  }
  finishHeader(block, format)
  blocks.push(block)
  if (entry.type === '0' && entry.size > 0) {
    const padded = new Uint8Array(Math.ceil(entry.size / BLOCK) * BLOCK)
    padded.set(entry.data)
    blocks.push(padded)
  }
  return blocks
}

const concat = chunks => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return bytes
}

// - names ------------------------------------------------------------------------------------------------------------------

/** GNU's exclusion match: the pattern matches the whole name or what follows any `/` in it (`*` matches `/` too) */
function excluded(name, patterns, o) {
  const text = name.replace(/\/+$/, '')
  for (const pattern of patterns) {
    const match = compilePattern(pattern, { caseFold: o.ignoreCase })
    if (match(text)) return true
    if (!o.anchored) {
      for (let i = 0; i < text.length; i++) if (text[i] === '/' && match(text.slice(i + 1))) return true
    }
  }
  return false
}

/** `s/regex/replacement/flags` expressions applied to member names (`--transform`) */
function parseTransform(expression) {
  const delimiter = expression[1]
  if (expression[0] !== 's' || !delimiter) throw new Usage(`Invalid transform expression: ${expression}`)
  const parts = []
  let current = ''
  for (let i = 2; i < expression.length; i++) {
    const ch = expression[i]
    if (ch === '\\' && expression[i + 1] === delimiter) { current += delimiter; i++; continue }
    if (ch === '\\') { current += ch + (expression[++i] ?? ''); continue }
    if (ch === delimiter) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  const [pattern, replacement, flags = ''] = parts
  if (pattern === undefined || replacement === undefined) throw new Usage(`Invalid transform expression: ${expression}`)
  const js = pattern.replace(/\\([(){}|+?])/g, '$1')
  const regex = new RegExp(js, (flags.includes('g') ? 'g' : '') + (flags.includes('i') || flags.includes('I') ? 'i' : ''))
  return name => name.replace(regex, replacement.replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'))
}

// - options --------------------------------------------------------------------------------------------------------------------

const LONG = {
  create: ['c'], extract: ['x'], get: ['x'], list: ['t'], append: ['r'], update: ['u'], catenate: ['A'], concatenate: ['A'], delete: ['delete'], diff: ['d'], compare: ['d'],
  file: ['f', 1], verbose: ['v'], gzip: ['z'], gunzip: ['z'], ungzip: ['z'], bzip2: ['j'], xz: ['J'], lzma: ['lzma'], zstd: ['zstd'], 'auto-compress': ['a'],
  directory: ['C', 1], exclude: ['exclude', 1], 'exclude-from': ['X', 1], 'files-from': ['T', 1], 'strip-components': ['strip', 1], 'to-stdout': ['O'],
  'keep-old-files': ['k'], 'skip-old-files': ['skip-old'], 'keep-newer-files': ['keep-newer'], overwrite: ['overwrite'], 'no-overwrite-dir': ['no-overwrite-dir'],
  'preserve-permissions': ['p'], 'same-permissions': ['p'], 'no-same-permissions': ['no-p'], 'same-owner': ['same-owner'], 'no-same-owner': ['no-same-owner'],
  touch: ['m'], 'numeric-owner': ['numeric-owner'], owner: ['owner', 1], group: ['group', 1], mtime: ['mtime', 1], mode: ['mode', 1], format: ['format', 1],
  dereference: ['h'], 'absolute-names': ['P'], 'one-top-level': ['one-top-level', 'optional'], transform: ['transform', 1], xform: ['transform', 1], wildcards: ['wildcards'],
  'no-wildcards': ['no-wildcards'], anchored: ['anchored'], 'no-anchored': ['no-anchored'], 'ignore-case': ['ignore-case'], null: ['null'], recursion: ['recursion'], 'no-recursion': ['no-recursion'],
  'remove-files': ['remove-files'], totals: ['totals', 'optional'], 'blocking-factor': ['b', 1], 'ignore-zeros': ['i'], checkpoint: ['checkpoint', 'optional'], sort: ['sort', 1],
  'use-compress-program': ['I', 1], 'format-version': ['f'], 'verify': ['W'], 'sparse': ['S'], 'index-file': ['index-file', 1], 'label': ['V', 1], 'one-file-system': ['one-file-system'],
  'old-archive': ['old'], 'posix': ['posix'], 'no-same-permissions ': ['no-p'], help: ['help'], usage: ['usage'], version: ['version'], 'show-omitted-dirs': ['show-omitted'], 'quote-chars': ['quote', 1],
  'show-transformed-names': ['show-transformed'], 'warning': ['warning', 1], 'overwrite-dir': ['overwrite-dir'], 'delay-directory-restore': ['delay'], 'no-delay-directory-restore': ['no-delay'],
  'pax-option': ['pax-option', 1], 'atime-preserve': ['atime-preserve', 'optional'], 'full-time': ['full-time'], 'utc': ['utc'], 'newer': ['newer', 1], 'after-date': ['newer', 1], 'newer-mtime': ['newer-mtime', 1], occurrence: ['occurrence', 'optional']
}
const SHORT_ARG = new Set(['f', 'C', 'T', 'X', 'b', 'I', 'L', 'N', 'V', 'H', 'K', 'F', 'g', 'M', 'R', 'n', 's', 'W'])
const MODES = new Set(['c', 'x', 't', 'r', 'u', 'A', 'delete', 'd'])

/**
 * The command line as `{ mode, o, items }`: `o` the global options and `items` the file names in order, each with the positional
 * state (directory, exclusions, transformation) in force where it stood.
 */
function parseCommandLine(args) {
  const o = {
    mode: undefined, file: undefined, verbose: 0, gzip: false, auto: false, strip: 0, toStdout: false, keepOld: false, skipOld: false, keepNewer: false,
    preserve: undefined, sameOwner: undefined, touch: false, numericOwner: false, owner: undefined, group: undefined, mtime: undefined, mode_: undefined,
    format: 'gnu', dereference: false, absolute: false, topLevel: undefined, wildcards: false, anchored: false, ignoreCase: false, nullSep: false, recursion: true,
    removeFiles: false, totals: false, blocking: 20, ignoreZeros: false, filesFrom: [], excludeFrom: [], newer: undefined, sort: 'name', compress: undefined, compressProgram: undefined, transforms: []
  }
  const state = { directory: undefined, excludes: [], recursion: true, transforms: [] }
  const items = []
  const optionsAfterNames = []
  const rest = [...args]
  // the old way: `tar cvf file names`, the first word without a dash
  if (rest.length && !rest[0].startsWith('-') && /^[A-Za-z?]+$/.test(rest[0])) {
    const letters = rest.shift()
    const converted = []
    const values = []
    for (const letter of letters) {
      converted.push(`-${letter}`)
      if (SHORT_ARG.has(letter)) { if (!rest.length) throw new Usage(`option requires an argument -- '${letter}'`); converted.push(rest.shift()) }
    }
    rest.unshift(...converted)
    void values
  }
  const apply = (key, value, seenName) => {
    switch (key) {
      case 'c': case 'x': case 't': case 'r': case 'u': case 'A': case 'delete': case 'd':
        if (o.mode && o.mode !== key) throw new Usage('You may not specify more than one \'-Acdtrux\', \'--delete\' or  \'--test-label\' option')
        o.mode = key
        break
      case 'f': o.file = value; break
      case 'v': o.verbose++; break
      case 'z': o.gzip = true; break
      case 'j': o.compress = 'bzip2'; break
      case 'J': o.compress = 'xz'; break
      case 'lzma': o.compress = 'lzma'; break
      case 'zstd': o.compress = 'zstd'; break
      case 'a': o.auto = true; break
      case 'C': state.directory = value; break
      case 'exclude': state.excludes = [...state.excludes, value]; if (seenName) optionsAfterNames.push('--exclude'); break
      case 'X': o.excludeFrom.push(value); break
      case 'T': o.filesFrom.push({ file: value, state: { ...state } }); items.push({ fromFile: value, state: { ...state } }); break
      case 'strip': o.strip = Number(value); if (!Number.isInteger(o.strip) || o.strip < 0) throw new Usage(`Invalid number of components to strip: ${value}`); break
      case 'O': o.toStdout = true; break
      case 'k': o.keepOld = true; break
      case 'skip-old': o.skipOld = true; break
      case 'keep-newer': o.keepNewer = true; break
      case 'p': o.preserve = true; break
      case 'no-p': o.preserve = false; break
      case 'same-owner': o.sameOwner = true; break
      case 'no-same-owner': o.sameOwner = false; break
      case 'm': o.touch = true; break
      case 'numeric-owner': o.numericOwner = true; break
      case 'owner': o.owner = value; break
      case 'group': o.group = value; break
      case 'mtime': o.mtime = value; break
      case 'mode': o.mode_ = value; break
      case 'format': if (!['gnu', 'ustar', 'posix', 'pax', 'v7', 'oldgnu'].includes(value)) throw new Usage(`Invalid archive format '${value}'`); o.format = value === 'pax' ? 'posix' : value === 'oldgnu' ? 'gnu' : value; break
      case 'old': o.format = 'v7'; break
      case 'posix': o.format = 'posix'; break
      case 'h': o.dereference = true; break
      case 'P': o.absolute = true; break
      case 'one-top-level': o.topLevel = value === true ? '' : value; break
      case 'transform': state.transforms = [...state.transforms, parseTransform(value)]; break
      case 'wildcards': o.wildcards = true; break
      case 'no-wildcards': o.wildcards = false; break
      case 'anchored': o.anchored = true; break
      case 'no-anchored': o.anchored = false; break
      case 'ignore-case': o.ignoreCase = true; break
      case 'null': o.nullSep = true; break
      case 'recursion': state.recursion = true; break
      case 'no-recursion': state.recursion = false; break
      case 'remove-files': o.removeFiles = true; break
      case 'totals': o.totals = true; break
      case 'b': o.blocking = Number(value); if (!Number.isInteger(o.blocking) || o.blocking < 1) throw new Usage(`Invalid blocking factor`); break
      case 'i': o.ignoreZeros = true; break
      case 'I': o.compressProgram = value; break
      case 'newer': case 'newer-mtime': o.newer = value; break
      case 'occurrence': o.occurrence = true; break
      case 'help': case 'usage': case 'version': o.informational = key; break
      default: break
    }
  }
  let seenName = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--') { for (const name of rest.slice(i + 1)) { items.push({ name, state: { ...state } }); seenName = true } break }
    if (arg === '-' || !arg.startsWith('-')) { items.push({ name: arg, state: { ...state } }); seenName = true; continue }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq)
      let spec = LONG[name]
      if (!spec) {
        const candidates = Object.keys(LONG).filter(key => key.startsWith(name))
        const distinct = new Set(candidates.map(key => LONG[key][0]))
        if (candidates.length === 0) throw new Usage(`unrecognized option '--${name}'`, 64)
        if (distinct.size > 1) throw new Usage(`option '--${name}' is ambiguous; possibilities:${candidates.map(c => ` '--${c}'`).join('')}`)
        spec = LONG[candidates[0]]
      }
      const [key, arity] = spec
      let value = true
      if (arity === 1) {
        if (eq >= 0) value = arg.slice(eq + 1)
        else if (i + 1 < rest.length) value = rest[++i]
        else throw new Usage(`option '--${name}' requires an argument`, 64)
      } else if (arity === 'optional') { if (eq >= 0) value = arg.slice(eq + 1) }
      else if (eq >= 0) throw new Usage(`option '--${name}' doesn't allow an argument`, 64)
      apply(key, value, seenName)
      continue
    }
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k]
      if (letter === '?') { o.informational = 'help'; continue }
      if (SHORT_ARG.has(letter)) {
        let value = arg.slice(k + 1)
        if (value === '') {
          if (i + 1 >= rest.length) throw new Usage(`option requires an argument -- '${letter}'`, 64)
          value = rest[++i]
        }
        apply(letter, value, seenName)
        break
      }
      if (!'cxtruAdvzjJaPhkpmOwWSBGgiVsT0lLoUXMRNnHxZyKFE'.includes(letter) && letter !== 'z') throw new Usage(`invalid option -- '${letter}'`, 64)
      if (letter === '0') { o.nullSep = true; continue }
      if (letter === 'w' || letter === 'B' || letter === 'G' || letter === 'g' || letter === 'o' || letter === 'U' || letter === 'M' || letter === 'l' || letter === 'S' || letter === 'W') continue
      apply(letter, true, seenName)
    }
  }
  o.optionsAfterNames = optionsAfterNames
  return { o, items, state }
}

// - the archive stream -----------------------------------------------------------------------------------------------------------------

async function through(bytes, transform) {
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader()
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return concat(chunks)
}

/** The programs the compressions other than gzip run through, as GNU tar runs them (with `-d` added to decompress) */
const FILTERS = { bzip2: ['bzip2'], xz: ['xz'], lzma: ['xz', '--format=lzma'], zstd: ['zstd', '-q'] }

/** The compression an archive's name asks for under `-a`, as GNU tar reads the suffix */
function compressionOfName(name) {
  if (!name) return undefined
  if (/\.(gz|tgz|taz)$/.test(name)) return 'gzip'
  if (/\.(bz2|tz2|tbz2|tbz)$/.test(name)) return 'bzip2'
  if (/\.(xz|txz)$/.test(name)) return 'xz'
  if (/\.(lzma|tlz)$/.test(name)) return 'lzma'
  if (/\.(zst|tzst)$/.test(name)) return 'zstd'
  return undefined
}

/** The compression `bytes` were made with, from their first bytes */
function compressionOfBytes(bytes) {
  const starts = (...magic) => bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte)
  if (starts(0x1f, 0x8b)) return 'gzip'
  if (starts(0x42, 0x5a, 0x68)) return 'bzip2'
  if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz'
  if (starts(0x28, 0xb5, 0x2f, 0xfd)) return 'zstd'
  return undefined
}

let scratchCount = 0

/**
 * `bytes` through `words` (a program and its arguments) as a filter: the program reads them on its standard input, from a
 * scratch file so neither side waits on the other, and what it writes to its standard output is the result.
 */
async function filter(words, bytes) {
  const program = findProgram(words[0])
  if (!program) throw new Fatal(`${words[0]}: Cannot exec: No such file or directory`, 2, 'Error is not recoverable: exiting now')
  const scratch = `/tmp/.tar-${getpid()}-${scratchCount++}`
  const input = open(scratch, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
  try { writeFdBytes(input, bytes) } finally { close(input) }
  let output
  let status
  try {
    const stdin = open(scratch, O_RDONLY)
    const [reader, writer] = pipe()
    let pid
    try { pid = await spawn(program, [words[0].split('/').pop(), ...words.slice(1)], { cwd: getcwd(), env, fds: { 0: stdin, 1: writer, 2: 2 } }) } finally {
      close(writer)
      close(stdin)
    }
    output = readAll(reader)
    close(reader)
    status = statusOf(await waitFor(pid))
  } finally {
    try { unlink(scratch) } catch { /* already gone */ }
  }
  if (status !== 0) throw new Fatal(`Child returned status ${status}`, 2, 'Error is not recoverable: exiting now')
  return output
}

/** The program words of a compression, or of `-I` */
const filterWords = (o, compression) => compression === 'program' ? o.compressProgram.split(/\s+/).filter(Boolean) : FILTERS[compression]

async function compress(o, compression, bytes) {
  if (compression === 'gzip') return await through(bytes, new CompressionStream('gzip'))
  return await filter(filterWords(o, compression), bytes)
}

async function decompress(o, compression, bytes) {
  if (compression === 'gzip') {
    try { return await through(bytes, new DecompressionStream('gzip')) } catch { throw new Fatal('Child returned status 1', 2, 'Error is not recoverable: exiting now') }
  }
  return await filter([...filterWords(o, compression), '-d'], bytes)
}

/** What `-z`, `-j`, `-J`, `--lzma`, `--zstd`, `-I` or (with `-a`) the archive's name ask to compress with, if anything */
function chosenCompression(o) {
  if (o.compressProgram !== undefined) return /^gzip( -c)?$/.test(o.compressProgram.trim()) ? 'gzip' : 'program'
  if (o.compress) return o.compress
  if (o.gzip) return 'gzip'
  if (o.auto) return compressionOfName(o.file)
  return undefined
}

async function readArchive(o) {
  let bytes
  try { bytes = o.file === undefined || o.file === '-' ? readFdBytes(0) : readFileBytes(resolve(getcwd(), o.file)) } catch (error) {
    throw new Fatal(`${o.file}: Cannot open: ${reasonOf(error)}`, 2, 'Error is not recoverable: exiting now')
  }
  // the bytes say what they are; `-I` is taken at its word, and lzma (whose header is too loose to tell by) is asked for
  // with --lzma or named by the archive's suffix
  const chosen = chosenCompression({ ...o, auto: false })
  const compression = chosen === 'program' || chosen === 'lzma' ? chosen : compressionOfBytes(bytes) ?? (compressionOfName(o.file) === 'lzma' ? 'lzma' : undefined)
  return compression ? await decompress(o, compression, bytes) : bytes
}

async function writeArchive(o, chunks) {
  const end = [new Uint8Array(BLOCK * 2)]
  const body = concat([...chunks, ...end])
  const record = o.blocking * BLOCK
  const padded = new Uint8Array(Math.ceil(body.length / record) * record)
  padded.set(body)
  const compression = chosenCompression(o)
  const bytes = compression ? await compress(o, compression, padded) : padded
  if (o.file === undefined || o.file === '-') { flushOut(); writeFdBytes(1, bytes); return }
  const fd = open(resolve(getcwd(), o.file), O_WRONLY | O_CREAT | O_TRUNC, 0o666)
  try { writeFdBytes(fd, bytes) } finally { close(fd) }
}

// - system tables ------------------------------------------------------------------------------------------------------------------------

function table(path) {
  const map = new Map()
  const names = new Map()
  try {
    for (const line of decoder.decode(readFileBytes(path)).split('\n')) {
      const fields = line.split(':')
      if (fields.length < 3) continue
      map.set(Number(fields[2]), fields[0])
      names.set(fields[0], Number(fields[2]))
    }
  } catch { /* none */ }
  return { map, names }
}
let passwd
let group
const userName = uid => (passwd ??= table('/etc/passwd')).map.get(uid) ?? ''
const groupName = gid => (group ??= table('/etc/group')).map.get(gid) ?? ''
const userId = name => (passwd ??= table('/etc/passwd')).names.get(name)
const groupId = name => (group ??= table('/etc/group')).names.get(name)

function parseMtime(text) {
  if (text === undefined) return undefined
  if (text.startsWith('@')) return Math.floor(Number(text.slice(1)))
  const ms = Date.parse(text)
  if (Number.isNaN(ms)) throw new Usage(`Substituting current time for missing timestamp`)
  return Math.floor(ms / 1000)
}

// - create -------------------------------------------------------------------------------------------------------------------------------

async function modeBits(o, mode, isDir) {
  if (o.mode_ === undefined) return mode
  if (/^[0-7]+$/.test(o.mode_)) return parseInt(o.mode_, 8)
  // symbolic changes such as g-w,o-rwx, from the current bits
  let bits = mode & 0o7777
  for (const clause of o.mode_.split(',')) {
    const match = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause)
    if (!match) throw new Usage(`${o.mode_}: Invalid mode`)
    const who = match[1] || 'a'
    let mask = 0
    for (const letter of match[3]) {
      const perm = letter === 'r' ? 4 : letter === 'w' ? 2 : letter === 'x' || (letter === 'X' && isDir) ? 1 : 0
      for (const target of who.includes('a') ? 'ugo' : who) mask |= perm << ({ u: 6, g: 3, o: 0 })[target]
    }
    let area = 0
    for (const target of who.includes('a') ? 'ugo' : who) area |= 7 << ({ u: 6, g: 3, o: 0 })[target]
    if (match[2] === '+') bits |= mask
    else if (match[2] === '-') bits &= ~mask
    else bits = (bits & ~area) | mask
  }
  return bits
}

async function createEntries(o, items, ctx) {
  const chunks = []
  const seen = new Map()
  let warnedAbsolute = false
  const transformAll = (name, state) => { for (const transform of state.transforms) name = transform(name); return name }
  const mtimeOverride = parseMtime(o.mtime)
  const ownerParts = o.owner === undefined ? undefined : o.owner.split(':')
  const groupParts = o.group === undefined ? undefined : o.group.split(':')
  const ownerId = ownerParts === undefined ? undefined : /^\d+$/.test(ownerParts[ownerParts.length - 1]) ? Number(ownerParts[ownerParts.length - 1]) : userId(ownerParts[0])
  const ownerName = ownerParts === undefined ? undefined : ownerParts.length > 1 ? ownerParts[0] : /^\d+$/.test(ownerParts[0]) ? (o.numericOwner ? '' : userName(ownerId)) : ownerParts[0]
  const groupIdValue = groupParts === undefined ? undefined : /^\d+$/.test(groupParts[groupParts.length - 1]) ? Number(groupParts[groupParts.length - 1]) : groupId(groupParts[0])
  const groupNameValue = groupParts === undefined ? undefined : groupParts.length > 1 ? groupParts[0] : /^\d+$/.test(groupParts[0]) ? (o.numericOwner ? '' : groupName(groupIdValue)) : groupParts[0]
  if (ownerParts && ownerId === undefined) throw new Usage(`${o.owner}: Invalid owner`)
  if (groupParts && groupIdValue === undefined) throw new Usage(`${o.group}: Invalid group`)

  const verbose = o.verbose
  const listing = verbose && (o.file === '-' || o.file === undefined) ? text => { flushOut(); writeFdBytes(2, encoder.encode(text)) } : out

  const add = async (diskName, state, storedName) => {
    const base = resolve(state.directory ? resolve(getcwd(), state.directory) : getcwd(), diskName)
    let s
    try { s = o.dereference ? stat(base) : lstat(base) } catch (error) {
      fail(`${storedName ?? diskName}: Cannot stat: ${reasonOf(error)}`)
      return
    }
    let name = storedName ?? diskName
    if (!o.absolute && name.startsWith('/')) {
      if (!warnedAbsolute) { err("Removing leading `/' from member names"); warnedAbsolute = true }
      name = name.replace(/^\/+/, '')
      if (name === '') name = '.'
    }
    const kind = s.mode & 0o170000
    const isDir = kind === 0o040000
    const isLink = kind === 0o120000
    const isFile = kind === 0o100000
    if (excluded(name, state.excludes, o)) return
    let shown = transformAll(name, state)
    if (isDir && !shown.endsWith('/')) shown += '/'
    const entry = {
      name: shown,
      mode: await modeBits(o, s.mode & 0o7777, isDir),
      uid: ownerId ?? s.uid,
      gid: groupIdValue ?? s.gid,
      size: isFile ? s.size : 0,
      mtime: mtimeOverride ?? Math.floor(s.mtimeMs / 1000),
      type: isDir ? '5' : isLink ? '2' : isFile ? '0' : kind === 0o010000 ? '6' : kind === 0o020000 ? '3' : kind === 0o060000 ? '4' : '0',
      linkname: '',
      uname: ownerName ?? (o.numericOwner ? '' : userName(s.uid)),
      gname: groupNameValue ?? (o.numericOwner ? '' : groupName(s.gid)),
      data: new Uint8Array()
    }
    if (isLink) { try { entry.linkname = readlink(base) } catch { entry.linkname = '' } }
    if (isFile && (s.nlink ?? 1) > 1 && s.ino !== undefined) {
      const key = `${s.dev ?? 0}:${s.ino}`
      if (seen.has(key)) { entry.type = '1'; entry.linkname = seen.get(key); entry.size = 0 }
      else seen.set(key, shown)
    }
    if (entry.type === '0' && entry.size > 0) {
      try { entry.data = readFileBytes(base) } catch (error) { fail(`${name}: Cannot open: ${reasonOf(error)}`); return }
      entry.size = entry.data.length
    }
    try { chunks.push(...memberBlocks(entry, o.format)) } catch (error) { if (error instanceof Fatal) { fail(error.message); return } throw error }
    if (verbose) {
      if (verbose > 1) listing(`${verboseLine(entry, o)}\n`)
      else listing(`${shown}\n`)
    }
    ctx.count++
    if (isDir && state.recursion) {
      let names = []
      try { names = readdir(base).map(e => (typeof e === 'string' ? e : e.name)).filter(n => n !== '.' && n !== '..') } catch (error) { fail(`${name}: Cannot open: ${reasonOf(error)}`) }
      names.sort()
      for (const child of names) await add(`${diskName.replace(/\/+$/, '')}/${child}`, state, `${name.replace(/\/+$/, '')}/${child}`)
    }
    if (o.removeFiles) { try { isDir ? rmdir(base) : unlink(base) } catch { /* left in place */ } }
  }
  for (const item of items) {
    if (item.fromFile !== undefined) {
      let text
      try { text = decoder.decode(item.fromFile === '-' ? readFdBytes(0) : readFileBytes(resolve(getcwd(), item.fromFile))) } catch (error) {
        throw new Fatal(`${item.fromFile}: Cannot stat: ${reasonOf(error)}`, 2, 'Error is not recoverable: exiting now')
      }
      for (const line of text.split(o.nullSep ? '\0' : '\n')) if (line !== '') await add(line, item.state)
      continue
    }
    await add(item.name, item.state)
  }
  return chunks
}

const pad2 = n => String(n).padStart(2, '0')

/** The line `tar -tv` shows for a member: type and mode, owner, size, time and name */
function verboseLine(entry, o) {
  const type = { '5': 'd', '2': 'l', '1': 'h', '3': 'c', '4': 'b', '6': 'p' }[entry.type] ?? '-'
  const bits = entry.mode & 0o7777
  let perms = ''
  const set = 'rwxrwxrwx'
  for (let i = 0; i < 9; i++) perms += bits & (0o400 >> i) ? set[i] : '-'
  if (bits & 0o4000) perms = perms.slice(0, 2) + (perms[2] === 'x' ? 's' : 'S') + perms.slice(3)
  if (bits & 0o2000) perms = perms.slice(0, 5) + (perms[5] === 'x' ? 's' : 'S') + perms.slice(6)
  if (bits & 0o1000) perms = perms.slice(0, 8) + (perms[8] === 'x' ? 't' : 'T')
  const owner = `${o.numericOwner || !entry.uname ? entry.uid : entry.uname}/${o.numericOwner || !entry.gname ? entry.gid : entry.gname}`
  const date = new Date(entry.mtime * 1000)
  const when = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  let name = entry.name
  if (entry.type === '2') name += ` -> ${entry.linkname}`
  else if (entry.type === '1') name += ` link to ${entry.linkname}`
  return `${type}${perms} ${owner} ${String(entry.size).padStart(Math.max(0, 19 - owner.length - 1))} ${when} ${name}`
}

// - list and extract ------------------------------------------------------------------------------------------------------------

function memberMatches(name, patterns, o) {
  if (patterns.length === 0) return true
  const text = name.replace(/\/+$/, '')
  for (const pattern of patterns) {
    const wanted = pattern.replace(/\/+$/, '')
    if (o.wildcards) {
      const match = compilePattern(wanted, { caseFold: o.ignoreCase })
      if (match(text) || match(text.split('/').slice(0, wanted.split('/').length).join('/'))) return true
      continue
    }
    if (o.ignoreCase ? text.toLowerCase() === wanted.toLowerCase() || text.toLowerCase().startsWith(wanted.toLowerCase() + '/') : text === wanted || text.startsWith(wanted + '/')) return true
  }
  return false
}

function mkdirP(path) {
  const parts = path.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current += '/' + part
    try { mkdir(current, 0o777) } catch { /* it is there, or the next step says why not */ }
  }
}

async function main() {
  let parsed
  try { parsed = parseCommandLine(argv.slice(1)) } catch (error) {
    if (error instanceof Usage) { err(error.message); err(HELP_HINT); return error.status ?? 64 }
    throw error
  }
  const { o, items, state: finalState } = parsed
  o.finalDirectory = finalState.directory
  if (o.informational === 'help') { out(usage + '\n'); return 0 }
  if (o.informational === 'usage') { out('Usage: tar [-Acdtrux?vzaCfhkmpOPTX] [--create] [--extract] [--list] [--file=ARCHIVE] [FILE]...\n'); return 0 }
  if (o.informational === 'version') { out('tar (ecmaOS) 1.35\n'); return 0 }
  if (!o.mode) { err("You must specify one of the '-Acdtrux', '--delete' or '--test-label' options"); err(HELP_HINT); return 2 }
  if (o.optionsAfterNames.length) {
    err(`The following options were used after non-option arguments.  These options are positional and affect only arguments that follow them.  Please, rearrange them properly.`)
    err(`${[...new Set(o.optionsAfterNames)].join(', ')} has no effect`)
  }
  if (o.mode === 'c') {
    if (items.length === 0) { err('Cowardly refusing to create an empty archive'); err(HELP_HINT); return 2 }
    const ctx = { count: 0 }
    const chunks = await createEntries(o, items, ctx)
    await writeArchive(o, chunks)
    if (o.totals) { flushOut(); err(`Total bytes written: ${Math.ceil((concat(chunks).length + BLOCK * 2) / (o.blocking * BLOCK)) * o.blocking * BLOCK} (${Math.ceil(concat(chunks).length / 1024)}KiB, ${Math.ceil(concat(chunks).length / 1024)}KiB/s)`) }
    flushOut()
    if (failures) { err('Exiting with failure status due to previous errors'); return 2 }
    return 0
  }
  if (o.mode === 'x' || o.mode === 't') return await listOrExtract(o, items)
  if (o.mode === 'r' || o.mode === 'u' || o.mode === 'delete' || o.mode === 'A') return await modify(o, items)
  if (o.mode === 'd') { err('--diff is not supported here'); return 2 }
  return 0
}

async function listOrExtract(o, items) {
  const names = items.filter(item => item.name !== undefined).map(item => item.name)
  const patterns = [...names]
  const excludeGlobal = [...(items[0]?.state.excludes ?? [])]
  for (const file of o.excludeFrom) { try { excludeGlobal.push(...decoder.decode(readFileBytes(resolve(getcwd(), file))).split('\n').filter(Boolean)) } catch (error) { throw new Fatal(`${file}: Cannot open: ${reasonOf(error)}`) } }
  if (o.mode === 't' && o.occurrence) { err('--occurrence is meaningless without a file list'); return 2 }
  const bytes = await readArchive(o)
  const { entries, problem } = parseArchive(bytes)
  if (entries.length === 0 && problem) { err(problem); err('Exiting with failure status due to previous errors'); return 2 }
  const state = items[items.length - 1]?.state ?? { directory: undefined, transforms: [] }
  const baseDir = o.finalDirectory
  const matched = new Set()
  const extracting = o.mode === 'x'
  const here = baseDir ? resolve(getcwd(), baseDir) : getcwd()
  let topLevel
  if (extracting && o.topLevel !== undefined) {
    topLevel = o.topLevel || (o.file ? o.file.split('/').pop().replace(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|tar)$/, '') : 'archive')
    mkdirP(resolve(here, topLevel))
  }
  const deferred = []
  const umask = await currentUmask()
  const sameOwner = o.sameOwner ?? (Number(getuid?.() ?? 1) === 0)
  const transform = name => { for (const t of state.transforms ?? []) name = t(name); return name }
  const stdoutChunks = []
  const hardlinks = []
  for (const entry of entries) {
    if (!memberMatches(entry.name, patterns, o)) continue
    if (excluded(entry.name, excludeGlobal, o)) continue
    for (let i = 0; i < patterns.length; i++) if (memberMatches(entry.name, [patterns[i]], o)) matched.add(i)
    let name = entry.name
    if (o.strip) {
      const parts = name.replace(/\/+$/, '').split('/')
      if (parts.length <= o.strip) continue
      name = parts.slice(o.strip).join('/') + (entry.name.endsWith('/') ? '/' : '')
    }
    name = transform(name)
    if (!o.absolute && name.startsWith('/')) name = name.replace(/^\/+/, '')
    if (name.split('/').includes('..') && !o.absolute) { fail(`${name}: Member name contains '..'`); continue }
    if (!extracting) {
      out(o.verbose ? `${verboseLine({ ...entry, name }, o)}\n` : `${name}\n`)
      continue
    }
    if (name === '' || name === '.' || name === './') { if (o.verbose) out(`${name}\n`); continue }
    if (o.verbose) out(`${name}\n`)
    if (o.toStdout) {
      if (entry.type === '0') stdoutChunks.push(entry.data)
      continue
    }
    const target = resolve(topLevel ? resolve(here, topLevel) : here, name.replace(/\/+$/, ''))
    mkdirP(target.slice(0, target.lastIndexOf('/')) || '/')
    let existing
    try { existing = lstat(target) } catch { existing = undefined }
    if (existing && entry.type !== '5') {
      if (o.keepOld) { fail(`${name}: Cannot open: File exists`); continue }
      if (o.skipOld) continue
      if (o.keepNewer && existing.mtimeMs / 1000 > entry.mtime) continue
    }
    try {
      if (entry.type === '5') {
        if (existing && (existing.mode & 0o170000) !== 0o040000) unlink(target)
        try { mkdir(target, 0o777) } catch (error) { if (!existing && !/EEXIST/.test(`${error?.code} ${error?.message}`)) throw error }
        deferred.push({ target, entry })
        continue
      }
      if (existing) { try { (existing.mode & 0o170000) === 0o040000 ? rmdir(target) : unlink(target) } catch { /* the open below says */ } }
      if (entry.type === '0') {
        const fd = open(target, O_WRONLY | O_CREAT | O_TRUNC, 0o666)
        try { writeFdBytes(fd, entry.data) } finally { close(fd) }
      } else if (entry.type === '2') symlink(entry.linkname, target)
      else if (entry.type === '1') hardlinks.push({ target, entry, name })
      else { err(`${name}: Cannot mknod: Operation not permitted`); failures++; continue }
      if (entry.type !== '2' && entry.type !== '1') {
        let mode = entry.mode & 0o7777
        if (!(o.preserve ?? false)) mode &= ~umask & 0o777
        try { await chmodOwned(sys, target, mode) } catch { /* the mode stays as created */ }
        if (!o.touch) { try { await utimesOwned(sys, target, entry.mtime, entry.mtime) } catch { /* times stay */ } }
        if (sameOwner) { try { await chownOwned(sys, target, entry.uid, entry.gid) } catch { /* not allowed */ } }
      }
    } catch (error) {
      fail(`${name}: Cannot ${entry.type === '2' ? 'create symlink to' : 'open'}${entry.type === '2' ? ` '${entry.linkname}'` : ''}: ${reasonOf(error)}`)
    }
  }
  for (const { target, entry, name } of hardlinks) {
    const source = resolve(topLevel ? resolve(here, topLevel) : here, transform(entry.linkname).replace(/^\/+/, ''))
    try { link(source, target) } catch (error) { fail(`${name}: Cannot hard link to '${entry.linkname}': ${reasonOf(error)}`) }
  }
  for (const { target, entry } of deferred.reverse()) {
    let mode = entry.mode & 0o7777
    if (!(o.preserve ?? false)) mode &= ~umask & 0o777
    try { await chmodOwned(sys, target, mode) } catch { /* left */ }
    if (!o.touch) { try { await utimesOwned(sys, target, entry.mtime, entry.mtime) } catch { /* left */ } }
    if (sameOwner) { try { await chownOwned(sys, target, entry.uid, entry.gid) } catch { /* left */ } }
  }
  if (stdoutChunks.length) { flushOut(); writeFdBytes(1, concat(stdoutChunks)) }
  patterns.forEach((pattern, index) => { if (!matched.has(index)) fail(`${pattern}: Not found in archive`) })
  if (problem && problem !== 'Skipping to next header') { err(problem); failures++ }
  flushOut()
  if (failures) { err('Exiting with failure status due to previous errors'); return 2 }
  return 0
}

async function currentUmask() {
  try { const m = Number(await sys.custom('proc_umask', -1)); if (m >= 0) return m } catch { /* the usual one */ }
  return 0o022
}

/** `-r`, `-u`, `--delete` and `-A`: the archive is read, changed and written back (compression is not allowed) */
async function modify(o, items) {
  if (o.file === undefined || o.file === '-') throw new Fatal('Cannot update compressed archives or standard input', 2)
  if (chosenCompression({ ...o, auto: false })) throw new Fatal('Cannot update compressed archives', 2)
  const path = resolve(getcwd(), o.file)
  let bytes
  try { bytes = readFileBytes(path) } catch (error) {
    if (o.mode === 'r' || o.mode === 'u') { bytes = new Uint8Array() } else throw new Fatal(`${o.file}: Cannot open: ${reasonOf(error)}`, 2, 'Error is not recoverable: exiting now')
  }
  if (['gzip', 'bzip2', 'xz', 'zstd'].includes(compressionOfBytes(bytes))) throw new Fatal('Cannot update compressed archives', 2)
  const { entries, problem } = parseArchive(bytes)
  if (bytes.length > 0 && entries.length === 0 && problem) { err(problem); err('Exiting with failure status due to previous errors'); return 2 }
  const kept = entries.map(entry => entry.raw)
  if (o.mode === 'delete') {
    const patterns = items.filter(item => item.name !== undefined).map(item => item.name)
    const matched = new Set()
    const remaining = []
    for (const entry of entries) {
      if (memberMatches(entry.name, patterns, o)) { patterns.forEach((pattern, index) => { if (memberMatches(entry.name, [pattern], o)) matched.add(index) }); continue }
      remaining.push(entry.raw)
    }
    patterns.forEach((pattern, index) => { if (!matched.has(index)) fail(`${pattern}: Not found in archive`) })
    await writeArchive({ ...o, gzip: false, auto: false, compress: undefined, compressProgram: undefined }, remaining)
  } else if (o.mode === 'A') {
    const chunks = [...kept]
    for (const item of items) {
      if (item.name === undefined) continue
      let other
      try { other = parseArchive(readFileBytes(resolve(getcwd(), item.name))) } catch (error) { fail(`${item.name}: Cannot open: ${reasonOf(error)}`); continue }
      chunks.push(...other.entries.map(entry => entry.raw))
    }
    await writeArchive({ ...o, gzip: false, auto: false, compress: undefined, compressProgram: undefined }, chunks)
  } else {
    let chunks
    if (o.mode === 'u') {
      // only what is newer than the copy in the archive, or not in it
      const newest = new Map()
      for (const entry of entries) newest.set(entry.name.replace(/\/+$/, ''), Math.max(newest.get(entry.name.replace(/\/+$/, '')) ?? 0, entry.mtime))
      const fresh = []
      const ctx = { count: 0 }
      const all = await createEntries({ ...o, verbose: 0 }, items, ctx)
      // `all` holds header and data blocks; keep the members whose time is newer (checked through a re-read)
      const reread = parseArchive(concat([...all, new Uint8Array(BLOCK * 2)]))
      for (const entry of reread.entries) {
        const known = newest.get(entry.name.replace(/\/+$/, ''))
        if (known === undefined || entry.mtime > known) fresh.push(entry.raw)
      }
      chunks = fresh
    } else chunks = await createEntries(o, items, { count: 0 })
    await writeArchive({ ...o, gzip: false, auto: false, compress: undefined, compressProgram: undefined }, [...kept, ...chunks])
  }
  flushOut()
  if (failures) { err('Exiting with failure status due to previous errors'); return 2 }
  return 0
}

try {
  const status = await main()
  flushOut()
  exit(status)
} catch (error) {
  flushOut()
  if (error instanceof Fatal) { err(error.message); if (error.extra) err(error.extra); exit(error.status ?? 2) }
  if (error instanceof Usage) { err(error.message); err(HELP_HINT); exit(error.status ?? 64) }
  writeFdBytes(2, encoder.encode(`tar: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(2)
}
