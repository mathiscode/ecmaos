/**
 * `unzip`: list, test and extract zip archives as Info-ZIP's unzip does, and `unzip -Z` (zipinfo) for the detailed listings.
 * Extracting asks before it replaces a file unless `-o` or `-n` say; `-d` picks the directory, `-j` drops paths, `-p` and `-c`
 * write to standard output, `-x` leaves names out, names and wildcards on the command line pick what is wanted.
 */

import { compile as compilePattern } from './lib/fnmatch.mjs'
import { readFdBytes, readFileBytes, writeFdBytes, writeFileBytes } from './lib/bytes.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'
import { entryData, extraTime, fromDos, readZip, ZipError } from './lib/zip-format.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, getcwd, lstat, mkdir, unlink, symlink, chmod, utimes, readdir } = sys

const encoder = new TextEncoder()
const out = text => writeFdBytes(1, encoder.encode(text))
const err = text => writeFdBytes(2, encoder.encode(text))

const usage = `UnZip 6.00 of 20 April 2009, by Info-ZIP.  Maintained by C. Spieler.  Send
bug reports using http://www.info-zip.org/zip-bug.html; see README for details.

Usage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]
  Default action is to extract files in list, except those in xlist, to exdir;
  file[.zip] may be a wildcard.  -Z => ZipInfo mode ("unzip -Z" for usage).

  -p  extract files to pipe, no messages     -l  list files (short format)
  -f  freshen existing files, create none    -t  test compressed archive data
  -u  update files, create if necessary      -z  display archive comment only
  -v  list verbosely/show version info       -T  timestamp archive to latest
  -x  exclude files that follow (in xlist)   -d  extract files into exdir
modifiers:
  -n  never overwrite existing files         -q  quiet mode (-qq => quieter)
  -o  overwrite files WITHOUT prompting      -a  auto-convert any text files
  -j  junk paths (do not make directories)   -C  match filenames case-insensitively
  -L  make (some) names lowercase            -V  retain VMS version numbers`

const exists = path => { try { lstat(path); return true } catch { return false } }

const two = n => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function mkdirP(path) {
  let current = ''
  for (const part of path.split('/').filter(Boolean)) {
    current += '/' + part
    try { mkdir(current, 0o777) } catch { /* there */ }
  }
}

function dateOf(entry) {
  const stamp = extraTime(entry.extra)
  return new Date(stamp !== undefined ? stamp * 1000 : fromDos(entry.date, entry.time))
}

/** What `-l` and `-v` show for the date: `YYYY-MM-DD HH:MM`, from the DOS fields */
const dosDate = entry => { const d = new Date(fromDos(entry.date, entry.time)); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` }

const percent = (size, compressed) => (size === 0 ? 0 : Math.round((1 - compressed / size) * 100))

async function main() {
  const args = argv.slice(1)
  const o = { mode: 'extract', overwrite: undefined, never: false, quiet: 0, junk: false, pipe: false, dir: undefined, excludes: [], names: [], freshen: false, update: false, lower: false, ignoreCase: false, zipinfo: false, zi: {} }
  let archive
  let target = 'names'
  const free = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { free.push(...args.slice(i + 1)); break }
    if (arg.startsWith('-Z') && i === 0 && !o.zipinfo) { o.zipinfo = true; for (const letter of arg.slice(2)) o.zi[letter] = true; continue }
    if (o.zipinfo && arg.startsWith('-') && arg.length > 1 && !archive) {
      for (const letter of arg.slice(1)) o.zi[letter] = true
      continue
    }
    if (target === 'exclude' && (!arg.startsWith('-') || arg === '-')) { o.excludes.push(arg); continue }
    if (target === 'dir') { o.dir = arg; target = 'names'; continue }
    if (!arg.startsWith('-') || arg === '-') { free.push(arg); continue }
    if (arg === '--help') { out(usage + '\n'); return 0 }
    target = 'names'
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k]
      if (letter === 'p') { o.pipe = true; o.quiet = Math.max(o.quiet, 2) }
      else if (letter === 'c') { o.pipe = true }
      else if (letter === 'l') o.mode = 'list'
      else if (letter === 'v') o.mode = 'verbose'
      else if (letter === 't') o.mode = 'test'
      else if (letter === 'z') o.mode = 'comment'
      else if (letter === 'q') o.quiet++
      else if (letter === 'o') o.overwrite = true
      else if (letter === 'n') o.never = true
      else if (letter === 'j') o.junk = true
      else if (letter === 'f') o.freshen = true
      else if (letter === 'u') o.update = true
      else if (letter === 'L') o.lower = true
      else if (letter === 'C') o.ignoreCase = true
      else if (letter === 'x') { target = 'exclude'; break }
      else if (letter === 'd') { const rest = arg.slice(k + 1); if (rest) o.dir = rest; else target = 'dir'; break }
      else if ('aVbBKsTXZ'.includes(letter)) { /* accepted */ }
      else { err(`caution: invalid option -${letter}\n`); return 10 }
    }
  }
  if (free.length === 0) { out(usage + '\n'); return o.zipinfo ? 0 : 10 }
  archive = free[0]
  if (archive === '-') { err(usage + '\n'); return 10 }
  o.names = free.slice(1)
  const cwd = getcwd()
  const candidates = [archive, archive + '.zip', archive + '.ZIP']
  const found = candidates.find(c => exists(resolve(cwd, c)))
  if (!found && archive !== '-') {
    err(`${o.zipinfo ? 'zipinfo' : 'unzip'}:  cannot find or open ${archive}, ${archive}.zip or ${archive}.ZIP.\n`)
    return 9
  }
  let bytes
  let parsed
  const shown = archive === '-' ? 'stdin' : found
  try {
    bytes = archive === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, found))
    parsed = readZip(bytes)
  } catch (error) {
    if (error instanceof ZipError) {
      err(`  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n  latter case the central directory and zipfile comment will be found on\n  the last disk(s) of this archive.\nunzip:  cannot find zipfile directory in one of ${archive} or\n        ${archive}.zip, and cannot find ${archive}.ZIP, period.\n`)
      return 9
    }
    err(`unzip: ${archive}: ${reasonOf(error)}\n`)
    return 9
  }
  const matchers = o.names.map(name => compilePattern(name, { caseFold: o.ignoreCase }))
  const excluders = o.excludes.map(name => compilePattern(name, { caseFold: o.ignoreCase }))
  const selected = parsed.entries.filter(entry => (matchers.length === 0 || matchers.some(match => match(entry.name))) && !excluders.some(match => match(entry.name)))
  let status = 0
  if (matchers.length) {
    for (const [index, match] of matchers.entries()) {
      if (!parsed.entries.some(entry => match(entry.name))) { err(`caution: filename not matched:  ${o.names[index]}\n`); status = 11 }
    }
  }
  if (o.zipinfo) return zipinfo(o, parsed, shown, selected, status, bytes.length)
  if (o.mode === 'comment') { out(`Archive:  ${shown}\n${parsed.comment ? parsed.comment + '\n' : ''}`); return 0 }
  if (o.mode === 'list' || o.mode === 'verbose') return listing(o, parsed, shown, selected, status)
  if (o.mode === 'test') {
    if (o.quiet < 2) out(`Archive:  ${shown}\n`)
    let bad = 0
    for (const entry of selected) {
      try { if (!entry.name.endsWith('/')) entryData(bytes, entry); if (o.quiet < 1) out(`    testing: ${entry.name.padEnd(24)} OK\n`) } catch (error) { bad++; if (o.quiet < 2) out(`    testing: ${entry.name.padEnd(24)} ${error.message}\n`) }
    }
    if (selected.length === 0 && status === 0) status = 11
    if (bad) { if (o.quiet < 2) out(`At least one error was detected in ${shown}.\n`); return 2 }
    if (o.quiet < 2) out(`No errors detected in compressed data of ${shown}.\n`)
    return status
  }
  // extract
  if (o.quiet < 1 && !o.pipe) out(`Archive:  ${shown}\n`)
  const base = o.dir ? resolve(cwd, o.dir) : cwd
  if (o.dir && !o.pipe) mkdirP(base)
  let skipped = 0
  let extracted = 0
  const deferred = []
  let all = false
  let none = false
  for (const entry of selected) {
    const isDir = entry.name.endsWith('/')
    let name = entry.name
    if (o.lower) name = name.toLowerCase()
    if (o.junk) name = name.replace(/\/+$/, '').split('/').pop() + (isDir ? '/' : '')
    if (name === '' || name === '/') continue
    if (name.split('/').includes('..')) { err(`warning:  skipped "../" path component(s) in ${entry.name}\n`); status = Math.max(status, 1); name = name.split('/').filter(p => p !== '..').join('/') }
    name = name.replace(/^\/+/, '')
    if (o.pipe) {
      if (isDir) continue
      try { writeFdBytes(1, entryData(bytes, entry)) } catch (error) { err(`error: ${error.message}\n`); status = Math.max(status, 2) }
      continue
    }
    const path = resolve(base, name)
    const shownName = o.dir ? `${o.dir.replace(/\/+$/, '')}/${name}` : name
    if (isDir) {
      if (!o.junk) {
        if (o.quiet < 1) out(`   creating: ${shownName}\n`)
        mkdirP(path)
        deferred.push({ path, entry })
      }
      continue
    }
    let present = exists(path)
    if (o.freshen && !present) continue
    if (present && (o.freshen || o.update)) {
      try { if (lstat(path).mtimeMs >= dateOf(entry).getTime() - 1000) { skipped++; continue } } catch { /* extract */ }
    }
    if (present && !o.overwrite) {
      if (o.never || none) { skipped++; continue }
      if (!all && !(o.freshen || o.update)) {
        // no one to ask: standard input is read for the answer, and an end of file means "none"
        err(`replace ${shownName}? [y]es, [n]o, [A]ll, [N]one, [r]ename:  NULL\n(EOF or read error, treating as "[N]one" ...)\n`)
        none = true
        skipped++
        continue
      }
    }
    mkdirP(path.slice(0, path.lastIndexOf('/')) || '/')
    let data
    try { data = entryData(bytes, entry) } catch (error) { err(`${shownName}:  ${error.message}\n`); status = Math.max(status, 2); continue }
    try {
      if (present) { try { unlink(path) } catch { /* the write says */ } }
      const mode = (entry.externalAttr >>> 16) & 0o7777
      if (((entry.externalAttr >>> 16) & 0o170000) === 0o120000) symlink(new TextDecoder().decode(data), path)
      else {
        writeFileBytes(path, data, mode ? mode & ~0o022 : 0o644)
        if (mode) { try { chmod(path, mode & 0o7777) } catch { /* left */ } }
      }
      const when = dateOf(entry).getTime() / 1000
      try { utimes(path, when, when) } catch { /* times stay */ }
      extracted++
      if (o.quiet < 1) out(`${entry.method === 8 ? '  inflating' : ' extracting'}: ${shownName.padEnd(24)}\n`)
    } catch (error) {
      err(`error:  cannot create ${shownName}\n        ${reasonOf(error)}\n`)
      status = Math.max(status, 2)
    }
  }
  for (const { path, entry } of deferred.reverse()) {
    const when = dateOf(entry).getTime() / 1000
    const mode = (entry.externalAttr >>> 16) & 0o7777
    if (mode) { try { chmod(path, mode) } catch { /* left */ } }
    try { utimes(path, when, when) } catch { /* left */ }
  }
  if (selected.length === 0 && status === 0) status = 11
  void skipped; void extracted; void readdir
  return status
}

function listing(o, parsed, shown, selected, status) {
  if (o.quiet < 1) out(`Archive:  ${shown}\n`)
  let totalSize = 0
  let totalCompressed = 0
  if (o.mode === 'list') {
    if (o.quiet < 2) { out('  Length      Date    Time    Name\n---------  ---------- -----   ----\n') }
    for (const entry of selected) {
      totalSize += entry.size
      if (o.quiet < 2) out(`${String(entry.size).padStart(9)}  ${dosDate(entry)}   ${entry.name}\n`)
    }
    if (o.quiet < 2) out(`---------                     -------\n${String(totalSize).padStart(9)}                     ${selected.length} file${selected.length === 1 ? '' : 's'}\n`)
    return selected.length === 0 && status === 0 ? 11 : status
  }
  out(' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n--------  ------  ------- ---- ---------- ----- --------  ----\n')
  for (const entry of selected) {
    totalSize += entry.size
    totalCompressed += entry.compressedSize
    const method = entry.method === 0 ? 'Stored' : entry.method === 8 ? 'Defl:N' : `Meth${entry.method}`
    out(`${String(entry.size).padStart(8)}  ${method.padEnd(6)} ${String(entry.compressedSize).padStart(8)} ${String(percent(entry.size, entry.compressedSize)).padStart(3)}% ${dosDate(entry)} ${entry.crc.toString(16).padStart(8, '0')}  ${entry.name}\n`)
  }
  out(`--------          -------  ---                            -------\n${String(totalSize).padStart(8)}         ${String(totalCompressed).padStart(8)} ${String(percent(totalSize, totalCompressed)).padStart(3)}%                            ${selected.length} file${selected.length === 1 ? '' : 's'}\n`)
  return selected.length === 0 && status === 0 ? 11 : status
}

function zipinfo(o, parsed, shown, selected, status, fileSize) {
  const flags = o.zi
  if (flags['1']) { for (const entry of selected) out(entry.name + '\n'); return status }
  const totalSize = selected.reduce((sum, e) => sum + e.size, 0)
  const totalCompressed = selected.reduce((sum, e) => sum + e.compressedSize, 0)
  const summary = `${selected.length} file${selected.length === 1 ? '' : 's'}, ${totalSize} bytes uncompressed, ${totalCompressed} bytes compressed:  ${(totalSize === 0 ? 0 : (1 - totalCompressed / totalSize) * 100).toFixed(1)}%\n`
  if (flags.t) { out(summary); return status }
  out(`Archive:  ${shown}\nZip file size: ${fileSize} bytes, number of entries: ${parsed.entries.length}\n`)
  for (const entry of selected) {
    const attr = (entry.externalAttr >>> 16) & 0xffff
    const type = entry.name.endsWith('/') ? 'd' : (attr & 0o170000) === 0o120000 ? 'l' : '-'
    let perms = ''
    for (let i = 0; i < 9; i++) perms += attr & (0o400 >> i) ? 'rwxrwxrwx'[i] : '-'
    const d = dateOf(entry)
    const when = `${two(d.getFullYear() % 100)}-${MONTHS[d.getMonth()]}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
    const method = entry.method === 0 ? 'stor' : entry.method === 8 ? 'defN' : `m${entry.method}`.padEnd(4)
    const host = entry.versionMade >> 8 === 3 ? 'unx' : 'fat'
    out(`${type}${perms}  ${((entry.versionMade & 0xff) / 10).toFixed(1)} ${host} ${String(entry.size).padStart(8)} ${entry.internalAttr & 1 ? 't' : 'b'}${(entry.extra.length ? 'x' : '-')} ${method} ${when} ${entry.name}\n`)
  }
  out(summary)
  return status
}

try {
  exit(await main())
} catch (error) {
  err(`unzip: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(2)
}
