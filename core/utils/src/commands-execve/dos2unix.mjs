/**
 * `dos2unix` and `unix2dos`: convert line breaks between DOS (CR LF) and Unix (LF), in place or (`-n`) to a new file,
 * and standard input to standard output when no file is named. A file that looks binary (it has a NUL, or other control
 * characters than tab, form feed, escape, CR and LF) is skipped unless `-f`. A UTF-8 byte order mark is removed by
 * dos2unix and kept by unix2dos, unless `-b`, `-r` or `-m` says otherwise.
 */

import { reasonOf } from './lib/errno.mjs'
import { readFdBytes, readFileBytes } from './lib/bytes.mjs'

const { argv, exit, writeAll, open, close, stat, chmod, utimes, rename, unlink, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
const name = (argv[0] ?? 'dos2unix').split('/').pop()
const toDos = name === 'unix2dos'
const encoder = new TextEncoder()
const say = text => writeAll(2, encoder.encode(`${name}: ${text}\n`))

const usage = `Usage: ${name} [options] [file ...] [-n infile outfile ...]
 -b, --keep-bom        keep Byte Order Mark
 -f, --force           force conversion of binary files
 -h, --help            display this help text
 -k, --keepdate        keep output file date
 -m, --add-bom         add Byte Order Mark (default UTF-8)
 -n, --newfile         write to new file
       infile          original file in new-file mode
       outfile         output file in new-file mode
 -o, --oldfile         write to old file (default)
       file ...        files to convert in old-file mode
 -q, --quiet           quiet mode, suppress all warnings
 -r, --remove-bom      remove Byte Order Mark
 -V, --version         display version number`

const BOM = [0xef, 0xbb, 0xbf]

function binary(bytes) {
  for (const byte of bytes) if (byte === 0 || (byte < 32 && ![9, 10, 12, 13, 27].includes(byte))) return true
  return false
}

function convert(bytes, bom) {
  let start = 0
  const hasBom = bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
  if (hasBom) start = 3
  const out = []
  const keepBom = bom === 'add' || (bom === 'keep' ? hasBom : bom === 'remove' ? false : toDos && hasBom)
  if (keepBom) out.push(...BOM)
  for (let i = start; i < bytes.length; i++) {
    const byte = bytes[i]
    if (toDos) {
      if (byte === 10 && bytes[i - 1] !== 13) out.push(13)
      out.push(byte)
    } else if (!(byte === 13 && bytes[i + 1] === 10)) out.push(byte)
  }
  return new Uint8Array(out)
}

function main() {
  const args = argv.slice(1)
  const o = { force: false, keepDate: false, quiet: false, bom: undefined }
  const jobs = []
  let newFile = false
  let pending = []
  for (const arg of args) {
    if (arg.startsWith('-') && arg.length > 1 && !pending.length) {
      const flag = { '--keep-bom': 'b', '--force': 'f', '--help': 'h', '--keepdate': 'k', '--add-bom': 'm', '--newfile': 'n', '--oldfile': 'o', '--quiet': 'q', '--remove-bom': 'r', '--version': 'V' }[arg] ?? (arg.length === 2 ? arg[1] : undefined)
      if (flag === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
      if (flag === 'V') { writeAll(1, encoder.encode(`${name} 7.5.2 (ecmaOS)\n`)); return 0 }
      if (flag === 'b') o.bom = 'keep'
      else if (flag === 'r') o.bom = 'remove'
      else if (flag === 'm') o.bom = 'add'
      else if (flag === 'f') o.force = true
      else if (flag === 'k') o.keepDate = true
      else if (flag === 'q') o.quiet = true
      else if (flag === 'n') newFile = true
      else if (flag === 'o') newFile = false
      else if (flag === 'c' || flag === 'a' || flag === 'l' || flag === 's') { /* conversion modes: ascii is the only one */ }
      else { say(`option '${arg}' unknown`); writeAll(2, encoder.encode(usage + '\n')); return 2 }
      continue
    }
    if (newFile) {
      pending.push(arg)
      if (pending.length === 2) { jobs.push({ from: pending[0], to: pending[1] }); pending = [] }
    } else jobs.push({ from: arg, to: arg })
  }
  if (pending.length) { say(`target of file ${pending[0]} not specified in new-file mode`); return 1 }
  if (jobs.length === 0) {
    const bytes = readFdBytes(0)
    writeAll(1, convert(bytes, o.bom))
    return 0
  }
  let status = 0
  for (const { from, to } of jobs) {
    let bytes
    let info
    try { info = stat(from); bytes = readFileBytes(from) } catch (e) { say(`${from}: ${reasonOf(e)}`); status = 1; continue }
    if ((info.mode & 0o170000) !== 0o100000) { if (!o.quiet) say(`Skipping ${from}, not a regular file.`); continue }
    if (!o.force && binary(bytes)) { if (!o.quiet) say(`Binary symbol found at line 1\n${name}: Skipping binary file ${from}`); continue }
    const converted = convert(bytes, o.bom)
    if (!o.quiet) say(from === to ? `converting file ${from} to ${toDos ? 'DOS' : 'Unix'} format...` : `converting file ${from} to file ${to} in ${toDos ? 'DOS' : 'Unix'} format...`)
    // written beside the file and renamed over it, so a failed write leaves the original
    const temporary = `${to}.d2utmp${Math.random().toString(36).slice(2, 8)}`
    try {
      const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, info.mode & 0o7777)
      try { writeAll(fd, converted) } finally { close(fd) }
      chmod(temporary, info.mode & 0o7777)
      if (o.keepDate) utimes(temporary, info.atimeMs / 1000, info.mtimeMs / 1000)
      rename(temporary, to)
    } catch (e) {
      try { unlink(temporary) } catch { /* not made */ }
      say(`${to}: ${reasonOf(e)}`)
      status = 1
    }
  }
  return status
}

try {
  exit(main())
} catch (error) {
  say(reasonOf(error))
  exit(1)
}
