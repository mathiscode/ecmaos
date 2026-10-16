/**
 * Display file status, as GNU `stat` does: the default multi-line report, `-c FORMAT` / `--printf=FORMAT` with every
 * format sequence (`%n %s %F %a %A %u %U %g %G %h %i %b %B %d %D %f %t %T %o %C %N %x %y %z %w %X %Y %Z %W`, flags and
 * widths), `-t` for the terse line, `-L` to follow symlinks, and `-f` for the status of the file system (`%a %b %c %d %f %i %l %n %s %S %t %T`).
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { strftime } from './lib/strftime.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat, lstat, readlink, env } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`stat: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('stat') + '\n'))

const S_IFMT = 0xf000
/** 512-byte units of the space a file takes: whole 4 KiB blocks, and none for a directory, symlink or device (as `du` counts) */
const blocksOf = s => {
  const kind = s.mode & 0xf000
  return kind === 0x4000 || kind === 0xa000 || kind === 0x2000 || kind === 0x6000 ? 0 : 8 * Math.ceil(s.size / 4096)
}

const KINDS = {
  0x8000: 'regular file', 0x4000: 'directory', 0xa000: 'symbolic link', 0x2000: 'character special file',
  0x6000: 'block special file', 0x1000: 'fifo', 0xc000: 'socket'
}
const LETTER = { 0x8000: '-', 0x4000: 'd', 0xa000: 'l', 0x2000: 'c', 0x6000: 'b', 0x1000: 'p', 0xc000: 's' }

const usage = `Usage: stat [OPTION]... FILE...
Display file status.

  -L, --dereference     follow links
  -f, --file-system     display file system status instead of file status
  -c  --format=FORMAT   use the specified FORMAT instead of the default; output a newline after each use of FORMAT
      --printf=FORMAT   like --format, but interpret backslash escapes, and do not output a mandatory trailing newline
  -t, --terse           print the information in terse form
      --help            display this help and exit`

let passwd, group
const table = path => {
  const map = new Map()
  try {
    const fd = sys.open(path, sys.O_RDONLY)
    try {
      const chunks = []
      const buffer = new Uint8Array(65536)
      for (;;) { const n = sys.read(fd, buffer, -1); if (n <= 0) break; chunks.push(new TextDecoder().decode(buffer.subarray(0, n))) }
      for (const line of chunks.join('').split('\n')) {
        const f = line.split(':')
        if (f.length >= 3 && /^\d+$/.test(f[2]) && !map.has(Number(f[2]))) map.set(Number(f[2]), f[0])
      }
    } finally { sys.close(fd) }
  } catch { /* no table */ }
  return map
}
const userName = id => (passwd ??= table('/etc/passwd')).get(id) ?? 'UNKNOWN'
const groupName = id => (group ??= table('/etc/group')).get(id) ?? 'UNKNOWN'

const symbolic = mode => {
  const bits = 'rwxrwxrwx'
  let s = LETTER[mode & S_IFMT] ?? '?'
  for (let i = 0; i < 9; i++) s += mode & (0o400 >> i) ? bits[i] : '-'
  const c = s.split('')
  if (mode & 0o4000) c[3] = mode & 0o100 ? 's' : 'S'
  if (mode & 0o2000) c[6] = mode & 0o010 ? 's' : 'S'
  if (mode & 0o1000) c[9] = mode & 0o001 ? 't' : 'T'
  return c.join('')
}

const utc = () => env?.TZ !== undefined && /^(UTC|GMT|UCT)(0)?$/.test(env.TZ)
const pad2 = n => String(n).padStart(2, '0')
function human(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '-'
  const isUtc = utc()
  const d = new Date(Math.floor(ms / 1000) * 1000)
  const base = strftime('%Y-%m-%d %H:%M:%S', { ms: d.getTime(), utc: isUtc })
  const frac = String(Math.floor(((ms % 1000) + 1000) % 1000)).padStart(3, '0') + '000000'
  return `${base}.${frac} ${strftime('%z', { ms, utc: isUtc })}`
}
const seconds = ms => (ms === undefined || ms === null ? 0 : Math.floor(ms / 1000))

/** Escapes of `--printf`: `\n \t \\ \" \a \b \f \r \v \e \NNN \xHH` */
function unescape(text) {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') { result += text[i]; continue }
    const c = text[++i]
    if (c === undefined) { result += '\\'; break }
    const simple = { n: '\n', t: '\t', '\\': '\\', '"': '"', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v', e: '\x1b' }
    if (c in simple) result += simple[c]
    else if (/[0-7]/.test(c)) {
      let oct = c
      while (oct.length < 3 && /[0-7]/.test(text[i + 1] ?? '')) oct += text[++i]
      result += String.fromCharCode(parseInt(oct, 8))
    } else if (c === 'x' && /[0-9a-fA-F]/.test(text[i + 1] ?? '')) {
      let hex = ''
      while (hex.length < 2 && /[0-9a-fA-F]/.test(text[i + 1] ?? '')) hex += text[++i]
      result += String.fromCharCode(parseInt(hex, 16))
    } else result += '\\' + c
  }
  return result
}

const quoteName = name => `'${name}'`


const FS_TYPES = {
  0x01021994: 'tmpfs', 0xef53: 'ext2/ext3', 0x9fa0: 'proc', 0x62656572: 'sysfs', 0x794c7630: 'overlayfs', 0x858458f6: 'ramfs',
  0x1cd1: 'devpts', 0x58465342: 'xfs', 0x9123683e: 'btrfs', 0x65735546: 'fuseblk', 0x6969: 'nfs', 0x4d44: 'msdos', 0x52654973: 'reiserfs'
}
const fsTypeName = type => FS_TYPES[type >>> 0] ?? `UNKNOWN (0x${(type >>> 0).toString(16)})`

function fsField(key, ctx) {
  const f = ctx.fsInfo
  switch (key) {
    case 'a': return String(f.bavail)
    case 'b': return String(f.blocks)
    case 'c': return String(f.files)
    case 'd': return String(f.ffree)
    case 'f': return String(f.bfree)
    case 'i': return '0'
    case 'l': return String(f.namelen)
    case 'n': return ctx.name
    case 's': return String(f.bsize)
    case 'S': return String(f.frsize || f.bsize)
    case 't': return (f.type >>> 0).toString(16)
    case 'T': return fsTypeName(f.type)
    default: return undefined
  }
}

function fsReport(ctx) {
  const f = ctx.fsInfo
  return `  File: "${ctx.name}"
    ID: 0                Namelen: ${f.namelen}     Type: ${fsTypeName(f.type)}
Block size: ${String(f.bsize).padEnd(10)} Fundamental block size: ${f.frsize || f.bsize}
Blocks: Total: ${String(f.blocks).padEnd(10)} Free: ${String(f.bfree).padEnd(10)} Available: ${f.bavail}
Inodes: Total: ${String(f.files).padEnd(10)} Free: ${f.ffree}
`
}

function field(key, ctx) {
  if (ctx.fsInfo) return fsField(key, ctx)
  const { s, name, fullPath, isLink } = ctx
  const kind = s.mode & S_IFMT
  const dev = Number(s.dev ?? 0)
  const rdev = Number(s.rdev ?? 0)
  switch (key) {
    case 'a': return (s.mode & 0o7777).toString(8)
    case 'A': return symbolic(s.mode)
    case 'b': return String(blocksOf(s))
    case 'B': return '512'
    case 'C': return '?'
    case 'd': return String(dev)
    case 'D': return dev.toString(16)
    case 'f': return s.mode.toString(16)
    case 'F': return KINDS[kind] ?? 'weird file'
    case 'g': return String(s.gid)
    case 'G': return groupName(s.gid)
    case 'h': return String(s.nlink ?? 1)
    case 'i': return String(s.ino ?? 0)
    case 'm': return '/'
    case 'n': return name
    case 'N': {
      if (isLink) { try { return `${quoteName(name)} -> ${quoteName(readlink(fullPath))}` } catch { /* shown plain */ } }
      return quoteName(name)
    }
    case 'o': return String(s.blksize ?? 4096)
    case 's': return String(s.size)
    case 't': return (rdev >>> 20).toString(16)
    case 'T': return (rdev & 0xfffff).toString(16)
    case 'u': return String(s.uid)
    case 'U': return userName(s.uid)
    case 'w': return s.birthtimeMs ? human(s.birthtimeMs) : '-'
    case 'W': return s.birthtimeMs ? String(seconds(s.birthtimeMs)) : '0'
    case 'x': return human(s.atimeMs)
    case 'X': return String(seconds(s.atimeMs))
    case 'y': return human(s.mtimeMs)
    case 'Y': return String(seconds(s.mtimeMs))
    case 'z': return human(s.ctimeMs ?? s.mtimeMs)
    case 'Z': return String(seconds(s.ctimeMs ?? s.mtimeMs))
    default: return undefined
  }
}

function formatWith(format, ctx) {
  let result = ''
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') { result += format[i]; continue }
    let j = i + 1
    let flags = ''
    while ('-+ #0\''.includes(format[j] ?? 'x') && format[j] !== undefined) flags += format[j++]
    let width = ''
    while (/\d/.test(format[j] ?? '')) width += format[j++]
    let precision
    if (format[j] === '.') { j++; precision = ''; while (/\d/.test(format[j] ?? '')) precision += format[j++] }
    const key = format[j]
    if (key === undefined) { result += format.slice(i); break }
    if (key === '%') { result += '%'; i = j; continue }
    let text = field(key, ctx)
    if (text === undefined) { result += format.slice(i, j + 1); i = j; continue }
    if (precision !== undefined && precision !== '' && /[nNFAUG]/.test(key)) text = text.slice(0, Number(precision))
    if (width) {
      const w = Number(width)
      if (flags.includes('-')) text = text.padEnd(w)
      else text = text.padStart(w, flags.includes('0') && /^-?\d+$/.test(text) ? '0' : ' ')
    }
    result += text
    i = j
  }
  return result
}

function report(ctx) {
  const { s, name, fullPath, isLink } = ctx
  const kind = s.mode & S_IFMT
  let file = name
  if (isLink) { try { file = `${name} -> ${readlink(fullPath)}` } catch { /* shown plain */ } }
  const dev = Number(s.dev ?? 0)
  const rdev = Number(s.rdev ?? 0)
  const special = kind === 0x2000 || kind === 0x6000 ? `Device type: ${rdev >>> 20},${rdev & 0xfffff}` : ''
  const lines = [
    `  File: ${file}`,
    `  Size: ${String(s.size).padEnd(10)}\tBlocks: ${String(blocksOf(s)).padEnd(10)} IO Block: ${String(s.blksize ?? 4096).padEnd(6)} ${KINDS[kind] ?? 'weird file'}`,
    `Device: ${dev >> 8},${dev & 0xff}\tInode: ${String(s.ino ?? 0).padEnd(10)} Links: ${s.nlink ?? 1}${special ? '     ' + special : ''}`,
    `Access: (${(s.mode & 0o7777).toString(8).padStart(4, '0')}/${symbolic(s.mode)})  Uid: (${String(s.uid).padStart(5)}/${userName(s.uid).padStart(8)})   Gid: (${String(s.gid).padStart(5)}/${groupName(s.gid).padStart(8)})`,
    `Access: ${human(s.atimeMs)}`,
    `Modify: ${human(s.mtimeMs)}`,
    `Change: ${human(s.ctimeMs ?? s.mtimeMs)}`,
    ` Birth: ${s.birthtimeMs ? human(s.birthtimeMs) : '-'}`
  ]
  return lines.join('\n') + '\n'
}

function terse(ctx) {
  const { s, name } = ctx
  const rdev = Number(s.rdev ?? 0)
  return `${name} ${s.size} ${blocksOf(s)} ${s.mode.toString(16)} ${s.uid} ${s.gid} ${Number(s.dev ?? 0).toString(16)} ${s.ino ?? 0} ${s.nlink ?? 1} ${(rdev >>> 20).toString(16)} ${(rdev & 0xfffff).toString(16)} ${seconds(s.atimeMs)} ${seconds(s.mtimeMs)} ${seconds(s.ctimeMs ?? s.mtimeMs)} ${seconds(s.birthtimeMs)} ${s.blksize ?? 4096}\n`
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'Lc:ft',
    long: { dereference: 'L', format: { key: 'c', arg: 'required' }, 'file-system': 'f', printf: { key: 'printf', arg: 'required' }, terse: 't', help: 'help' }
  })
  if (error) { err(error); hint(); return 1 }
  let deref = false, format, printfFormat, terseOut = false, filesystem = false
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    else if (key === 'L') deref = true
    else if (key === 'c') format = value
    else if (key === 'printf') printfFormat = value
    else if (key === 't') terseOut = true
    else if (key === 'f') filesystem = true
  }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }

  const cwd = getcwd()
  let failed = false
  for (const operand of operands) {
    const fullPath = operand === '-' ? '/proc/self/fd/0' : resolve(cwd, operand)
    if (filesystem) {
      let fsInfo
      try { stat(fullPath); fsInfo = sys.statfs(fullPath) } catch (error) {
        err(`cannot read file system information for '${operand}': ${reasonOf(error)}`)
        failed = true
        continue
      }
      const fsCtx = { fsInfo, name: operand }
      if (printfFormat !== undefined) out(formatWith(unescape(printfFormat), fsCtx))
      else if (format !== undefined) out(formatWith(format, fsCtx) + '\n')
      else out(fsReport(fsCtx))
      continue
    }
    let s
    let isLink = false
    try {
      s = deref ? stat(fullPath) : lstat(fullPath)
      isLink = (s.mode & S_IFMT) === 0xa000
    } catch (error) {
      err(`cannot statx '${operand}': ${reasonOf(error)}`)
      failed = true
      continue
    }
    const ctx = { s, name: operand, fullPath, isLink }
    if (printfFormat !== undefined) out(formatWith(unescape(printfFormat), ctx))
    else if (format !== undefined) out(formatWith(format, ctx) + '\n')
    else if (terseOut) out(terse(ctx))
    else out(report(ctx))
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
