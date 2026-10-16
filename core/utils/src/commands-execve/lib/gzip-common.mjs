/**
 * `gzip`, `gunzip` and `zcat` as GNU gzip works. The container is written here (header with the file's name and time, CRC-32 and
 * length trailer) around the platform's DEFLATE stream, and read here with `inflate`, so members that follow one another, bad
 * checksums and truncated data are reported as GNU reports them.
 */

import { readFdBytes, readFileBytes, writeFdBytes, writeFileBytes, joinChunks } from './bytes.mjs'
import { crc32, inflate, InflateError } from './inflate.mjs'
import { reasonOf } from './errno.mjs'
import { basename, resolve } from './path-utils.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat, unlink, lstat, readdir, chmod, utimes } = sys

const encoder = new TextEncoder()
const decoder = new TextDecoder('latin1')

async function deflateRaw(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')).getReader()
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return joinChunks(chunks)
}

/** A gzip file: header (with the name unless `name` is undefined), the DEFLATE data, CRC-32 and length */
export async function gzipBytes(bytes, { name, mtime = 0, level = 6 } = {}) {
  const deflated = await deflateRaw(bytes)
  const nameBytes = name === undefined ? new Uint8Array() : encoder.encode(name)
  const header = new Uint8Array(10 + (name === undefined ? 0 : nameBytes.length + 1))
  header.set([0x1f, 0x8b, 8, name === undefined ? 0 : 8], 0)
  new DataView(header.buffer).setUint32(4, mtime >>> 0, true)
  header[8] = level === 9 ? 2 : level === 1 ? 4 : 0
  header[9] = 3
  if (name !== undefined) { header.set(nameBytes, 10); header[10 + nameBytes.length] = 0 }
  const trailer = new Uint8Array(8)
  const view = new DataView(trailer.buffer)
  view.setUint32(0, crc32(bytes), true)
  view.setUint32(4, bytes.length >>> 0, true)
  return { file: joinChunks([header, deflated, trailer]), headerLength: header.length }
}

/**
 * Reads the members of a gzip file: `{ members, data, trailing }`, each member `{ name, mtime, crc, size, headerLength,
 * compressedLength }`; throws `GzipError` with GNU's wording.
 */
export class GzipError extends Error {}

export function gunzipBytes(bytes) {
  const members = []
  const chunks = []
  let at = 0
  let trailing = 0
  while (at < bytes.length) {
    if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x8b) {
      if (members.length === 0) throw new GzipError('not in gzip format')
      trailing = bytes.length - at
      break
    }
    if (bytes[at + 2] !== 8) throw new GzipError('unknown compression method')
    const flags = bytes[at + 3]
    if (flags & 0xe0) throw new GzipError('has flags 0x' + flags.toString(16) + ' -- not supported')
    const mtime = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0, true)
    let p = at + 10
    if (flags & 4) { const extra = bytes[p] | (bytes[p + 1] << 8); p += 2 + extra }
    let name
    if (flags & 8) { const start = p; while (p < bytes.length && bytes[p] !== 0) p++; name = decoder.decode(bytes.subarray(start, p)); p++ }
    if (flags & 16) { while (p < bytes.length && bytes[p] !== 0) p++; p++ }
    if (flags & 2) p += 2
    if (p > bytes.length) throw new GzipError('unexpected end of file')
    let result
    try { result = inflate(bytes, p) } catch (error) {
      if (error instanceof InflateError) throw new GzipError(error.message)
      throw error
    }
    if (result.end + 8 > bytes.length) throw new GzipError('unexpected end of file')
    const view = new DataView(bytes.buffer, bytes.byteOffset + result.end, 8)
    const crc = view.getUint32(0, true)
    const size = view.getUint32(4, true)
    if (crc !== crc32(result.data)) throw new GzipError('invalid compressed data--crc error')
    if (size !== result.data.length >>> 0) throw new GzipError('invalid compressed data--length error')
    members.push({ name, mtime, crc, size: result.data.length, headerLength: p - at, compressedLength: result.end + 8 - at })
    chunks.push(result.data)
    at = result.end + 8
  }
  return { members, data: joinChunks(chunks), trailing }
}

const exists = path => { try { lstat(path); return true } catch { return false } }
const isDirectory = path => { try { return (lstat(path).mode & 0xf000) === 0x4000 } catch { return false } }

const percent = (uncompressed, compressed) => (uncompressed === 0 ? 0 : ((uncompressed - compressed) / uncompressed) * 100)
const pad = (text, width) => String(text).padStart(width)

/** `mode`: 'gzip', 'gunzip' or 'zcat', which decides the defaults. */
export async function main(mode) {
  const out = text => writeAll(1, encoder.encode(text))
  let quiet = false
  const err = text => writeAll(2, encoder.encode(`gzip: ${text}\n`))
  const note = text => { if (!quiet) err(text) }
  const usage = `Usage: gzip [OPTION]... [FILE]...
Compress or uncompress FILEs (by default, compress FILES in-place).

Mandatory arguments to long options are mandatory for short options too.

  -c, --stdout      write on standard output, keep original files unchanged
  -d, --decompress  decompress
  -f, --force       force overwrite of output file and compress links
  -h, --help        give this help
  -k, --keep        keep (don't delete) input files
  -l, --list        list compressed file contents
  -L, --license     display software license
  -n, --no-name     do not save or restore the original name and timestamp
  -N, --name        save or restore the original name and timestamp
  -q, --quiet       suppress all warnings
  -r, --recursive   operate recursively on directories
  -S, --suffix=SUF  use suffix SUF on compressed files
  -t, --test        test compressed file integrity
  -v, --verbose     verbose mode
  -V, --version     display version number
  -1, --fast        compress faster
  -9, --best        compress better

With no FILE, or when FILE is -, read standard input.`

  const o = { decompress: mode !== 'gzip', stdout: mode === 'zcat', keep: false, force: false, test: false, verbose: 0, list: false, name: undefined, recursive: false, suffix: '.gz', level: 6 }
  const files = []
  const args = argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg.startsWith('--')) {
      const [name, value] = arg.slice(2).split(/=(.*)/s)
      const LONG = { stdout: 'c', 'to-stdout': 'c', decompress: 'd', uncompress: 'd', force: 'f', help: 'h', keep: 'k', list: 'l', license: 'L', 'no-name': 'n', name: 'N', quiet: 'q', recursive: 'r', suffix: 'S', test: 't', verbose: 'v', version: 'V', fast: '1', best: '9', synchronous: 'sync', rsyncable: 'sync' }
      const candidates = Object.keys(LONG).filter(key => key === name || key.startsWith(name))
      const exact = LONG[name] ? [name] : candidates
      if (exact.length === 0) { writeAll(2, encoder.encode(`gzip: unrecognized option '--${name}'\nTry 'gzip --help' for more information.\n`)); return 1 }
      if (new Set(exact.map(key => LONG[key])).size > 1) { writeAll(2, encoder.encode(`gzip: option '--${name}' is ambiguous\nTry 'gzip --help' for more information.\n`)); return 1 }
      const letter = LONG[exact[0]]
      if (letter === 'S') { const v = value ?? args[++i]; if (v === undefined) { writeAll(2, encoder.encode(`gzip: option '--suffix' requires an argument\nTry 'gzip --help' for more information.\n`)); return 1 } o.suffix = v; continue }
      args.splice(i + 1, 0)
      apply(letter)
      continue
    }
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k]
      if (letter === 'S') {
        const v = arg.slice(k + 1) || args[++i]
        if (v === undefined) { writeAll(2, encoder.encode(`gzip: option requires an argument -- 'S'\nTry 'gzip --help' for more information.\n`)); return 1 }
        o.suffix = v
        break
      }
      if (!/[cdfhklLnNqrtvV1-9a]/.test(letter)) { writeAll(2, encoder.encode(`gzip: invalid option -- '${letter}'\nTry 'gzip --help' for more information.\n`)); return 1 }
      apply(letter)
    }
  }
  function apply(letter) {
    if (letter === 'c') o.stdout = true
    else if (letter === 'd') o.decompress = true
    else if (letter === 'f') o.force = true
    else if (letter === 'h') o.help = true
    else if (letter === 'k') o.keep = true
    else if (letter === 'l') { o.list = true; o.decompress = true }
    else if (letter === 'L') o.license = true
    else if (letter === 'n') o.name = false
    else if (letter === 'N') o.name = true
    else if (letter === 'q') quiet = true
    else if (letter === 'r') o.recursive = true
    else if (letter === 't') { o.test = true; o.decompress = true }
    else if (letter === 'v') o.verbose++
    else if (letter === 'V') o.version = true
    else if (/[1-9]/.test(letter)) o.level = Number(letter)
  }
  if (o.help) { out(usage + '\n'); return 0 }
  if (o.version) { out('gzip 1.14 (ecmaOS)\n'); return 0 }
  if (o.license) { out('gzip comes with NO WARRANTY, to the extent permitted by law.\n'); return 0 }

  const cwd = getcwd()
  let status = 0
  const warn = () => { if (status === 0) status = 2 }
  const stdoutParts = []

  const compressTo = async (bytes, name, mtime) => gzipBytes(bytes, { name: o.name === false ? undefined : name, mtime: o.name === false ? 0 : mtime, level: o.level })

  if (o.list) return await list(files, o, { out, err, cwd })

  const decompressBytes = (bytes, label) => {
    try {
      const result = gunzipBytes(bytes)
      if (result.trailing && !o.test) note(`${label}: decompression OK, trailing garbage ignored`)
      if (result.trailing) warn()
      return result
    } catch (error) {
      if (error instanceof GzipError) { err(`${label}: ${error.message}`); status = 1; return undefined }
      throw error
    }
  }

  const treat = async file => {
    if (file === '-') {
      const input = readFdBytes(0)
      if (o.decompress) {
        const result = decompressBytes(input, 'stdin')
        if (!result) return
        if (!o.test) writeFdBytes(1, result.data)
        else if (o.verbose) err('stdin:\t OK')
        return
      }
      if (!o.force && process_isTty()) { err('compressed data not written to a terminal. Use -f to force compression.'); status = 1; return }
      const { file: packed } = await compressTo(input, undefined, 0)
      writeFdBytes(1, packed)
      if (o.verbose) writeAll(2, encoder.encode(`stdin:\t${pad(percent(input.length, packed.length - 18).toFixed(1), 5)}% -- replaced with stdout\n`))
      return
    }
    const path = resolve(cwd, file)
    if (!exists(path)) {
      // a name without the suffix may be a file with it
      const withSuffix = path + (o.decompress ? o.suffix : '')
      if (o.decompress && !file.endsWith(o.suffix) && exists(withSuffix)) return await treat(file + o.suffix)
      err(`${file}: No such file or directory`)
      status = 1
      return
    }
    if (isDirectory(path)) {
      if (!o.recursive) { note(`${file} is a directory -- ignored`); warn(); return }
      let names = []
      try { names = readdir(path).map(e => (typeof e === 'string' ? e : e.name)).filter(n => n !== '.' && n !== '..').sort() } catch { /* nothing */ }
      for (const child of names) await treat(`${file.replace(/\/+$/, '')}/${child}`)
      return
    }
    const info = stat(path)
    const suffixes = [o.suffix, '.z', '-z', '_z', '.Z', '-gz', '.tgz', '.taz']
    const matched = suffixes.find(s => file.endsWith(s) && file.length > s.length)
    if (o.decompress) {
      if (!matched && !o.stdout && !o.test) { note(`${file}: unknown suffix -- ignored`); warn(); return }
    } else if (matched === o.suffix && !o.force && !o.stdout) {
      note(`${file} already has ${o.suffix} suffix -- unchanged`)
      warn()
      return
    }
    let input
    try { input = readFileBytes(path) } catch (error) { err(`${file}: ${reasonOf(error)}`); status = 1; return }
    let result
    let target
    let outputBytes
    let when = Math.floor(info.mtimeMs / 1000)
    if (o.decompress) {
      result = decompressBytes(input, file)
      if (!result) return
      outputBytes = result.data
      if (o.test) { if (o.verbose) err(`${file}:\t OK`); return }
      const first = result.members[0]
      if (first.mtime && o.name !== false) when = first.mtime
      const base = matched ? file.slice(0, file.length - matched.length) + (matched === '.tgz' || matched === '.taz' ? '.tar' : '') : file
      target = o.name === true && first.name ? `${file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''}${first.name}` : base
    } else {
      const packed = await compressTo(input, basename(file), when)
      outputBytes = packed.file
      result = { headerLength: packed.headerLength }
      target = file + o.suffix
    }
    if (o.stdout) {
      writeFdBytes(1, outputBytes)
      if (o.verbose) writeAll(2, encoder.encode(`${file}:\t${pad(percent(o.decompress ? outputBytes.length : input.length, o.decompress ? input.length : outputBytes.length - result.headerLength - 8).toFixed(1), 5)}% -- replaced with stdout\n`))
      return
    }
    const targetPath = resolve(cwd, target)
    if (exists(targetPath)) {
      if (!o.force) { note(`${target} already exists;\tnot overwritten`); warn(); return }
      try { unlink(targetPath) } catch { /* the write says */ }
    }
    try { writeFileBytes(targetPath, outputBytes, info.mode & 0o7777) } catch (error) { err(`${target}: ${reasonOf(error)}`); status = 1; return }
    try { chmod(targetPath, info.mode & 0o7777); utimes(targetPath, info.atimeMs / 1000, when) } catch { /* the times and mode stay as written */ }
    if (!o.keep) { try { unlink(path) } catch (error) { err(`${file}: ${reasonOf(error)}`); status = 1 } }
    if (o.verbose) {
      const ratio = o.decompress ? percent(outputBytes.length, input.length - result.members[0].headerLength - 8) : percent(input.length, outputBytes.length - result.headerLength - 8)
      writeAll(2, encoder.encode(`${file}:\t${pad(ratio.toFixed(1), 5)}% -- ${o.keep ? 'created' : 'replaced with'} ${target}\n`))
    }
  }

  if (files.length === 0) await treat('-')
  else for (const file of files) await treat(file)
  void stdoutParts
  return status
}

const process_isTty = () => { try { return Boolean(sys.isatty?.(1)) } catch { return false } }

/** `gzip -l`: sizes and ratios of compressed files */
async function list(files, o, { out, err, cwd }) {
  const names = files.length ? files : ['-']
  let totalCompressed = 0
  let totalUncompressed = 0
  let lastOverhead = 0
  let status = 0
  const rows = []
  for (const file of names) {
    let bytes
    try { bytes = file === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, file)) } catch (error) { err(`${file}: ${reasonOf(error)}`); status = 1; continue }
    let result
    try { result = gunzipBytes(bytes) } catch (error) { if (error instanceof GzipError) { err(`${file}: ${error.message}`); status = status || 1; continue } throw error }
    const last = result.members[result.members.length - 1]
    const compressed = bytes.length
    const uncompressed = result.data.length
    const deflate = compressed - result.members.reduce((sum, m) => sum + m.headerLength + 8, 0)
    const name = file === '-' ? 'stdout' : file.replace(/(\.gz|\.tgz|\.z|-z|_z|\.Z)$/, m => (m === '.tgz' ? '.tar' : ''))
    rows.push({ file, compressed, uncompressed, ratio: percent(uncompressed, deflate), name, first: result.members[0], crc: result.members[0].crc })
    totalCompressed += compressed
    totalUncompressed += uncompressed
    lastOverhead = last.headerLength + 8
  }
  if (rows.length === 0) return status
  const verbose = o.verbose > 0
  if (!(o.quiet)) out(verbose ? 'method  crc     date  time           compressed        uncompressed  ratio uncompressed_name\n' : '         compressed        uncompressed  ratio uncompressed_name\n')
  for (const row of rows) {
    const prefix = verbose ? `defla ${row.crc.toString(16).padStart(8, '0')} ${dateText(row.first.mtime || 0)} ` : ''
    out(`${prefix}${pad(row.compressed, 19)} ${pad(row.uncompressed, 19)} ${pad(row.ratio.toFixed(1), 5)}% ${row.name}\n`)
  }
  if (rows.length > 1) {
    const ratio = percent(totalUncompressed, totalCompressed - lastOverhead)
    out(`${verbose ? '                            ' : ''}${pad(totalCompressed, 19)} ${pad(totalUncompressed, 19)} ${pad(ratio.toFixed(1), 5)}% (totals)\n`)
  }
  return status
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dateText(seconds) {
  const d = new Date(seconds * 1000)
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export async function start(mode) {
  try { exit(await main(mode)) } catch (error) {
    writeAll(2, encoder.encode(`gzip: ${error?.message ?? String(error)}\n`))
    exit(1)
  }
}
