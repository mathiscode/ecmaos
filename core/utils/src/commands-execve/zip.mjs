/**
 * `zip`: package and compress files into a zip archive as Info-ZIP's zip does. Adds to an archive that exists (replacing entries of
 * the same name), `-d` deletes, `-u`/`-f` add only newer files, `-r` goes into directories, `-j` drops paths, `-0` to `-9` set the
 * compression (0 stores), `-x` and `-i` choose by pattern, `-m` moves, `-q` is quiet, and `-` as a name reads standard input.
 */

import { compile as compilePattern } from './lib/fnmatch.mjs'
import { readFdBytes, readFileBytes, writeFdBytes, writeFileBytes } from './lib/bytes.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'
import { assemble, carry, makeEntry, readZip, ZipError } from './lib/zip-format.mjs'

const { argv, exit, getcwd, lstat, stat, readdir, unlink, rmdir, readlink } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeFdBytes(1, encoder.encode(text))
// Info-ZIP prints its warnings and errors on standard output
const err = text => writeFdBytes(1, encoder.encode(text))

const usage = `Copyright (c) 1990-2008 Info-ZIP - Type 'zip "-L"' for software license.
Zip 3.0 (July 5th 2008). Usage:
zip [-options] [-b path] [-t mmddyyyy] [-n suffixes] [zipfile list] [-xi list]
  The default action is to add or replace zipfile entries from list, which
  can include the special name - to compress standard input.
  If zipfile and list are omitted, zip compresses stdin to stdout.
  -f   freshen: only changed files  -u   update: only changed or new files
  -d   delete entries in zipfile    -m   move into zipfile (delete OS files)
  -r   recurse into directories     -j   junk (don't record) directory names
  -0   store only                   -l   convert LF to CR LF (-ll CR LF to LF)
  -1   compress faster              -9   compress better
  -q   quiet operation              -v   verbose operation/print version info
  -c   add one-line comments        -z   add zipfile comment
  -@   read names from stdin        -o   make zipfile as old as latest entry
  -x   exclude the following names  -i   include only the following names
  -D   do not add directory entries -X   eXclude eXtra file attributes
  -y   store symbolic links as the link instead of the referenced file`

const exists = path => { try { lstat(path); return true } catch { return false } }
const isDirectory = path => { try { return (stat(path).mode & 0o170000) === 0o040000 } catch { return false } }

async function main() {
  const args = argv.slice(1)
  const o = { recurse: false, junk: false, quiet: false, delete: false, update: false, freshen: false, move: false, level: 6, excludes: [], includes: [], noDirs: false, noExtra: false, stdinNames: false, symlinks: false }
  const operands = []
  let target = 'operands'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (target !== 'operands' && (!arg.startsWith('-') || arg === '-')) { (target === 'exclude' ? o.excludes : o.includes).push(arg); continue }
    if (arg === '-' || !arg.startsWith('-')) { operands.push(arg); continue }
    if (arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '--version') { out('Zip 3.0 (ecmaOS)\n'); return 0 }
    if (arg.startsWith('--')) { err(`\nzip error: Invalid command arguments (no such option: ${arg})\n`); return 16 }
    target = 'operands'
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k]
      if (letter === 'r') o.recurse = true
      else if (letter === 'R') o.recurse = true
      else if (letter === 'j') o.junk = true
      else if (letter === 'q') o.quiet = true
      else if (letter === 'd') o.delete = true
      else if (letter === 'u') o.update = true
      else if (letter === 'f') o.freshen = true
      else if (letter === 'g') { /* grow: the same as adding */ }
      else if (letter === 'm') o.move = true
      else if (letter === 'D') o.noDirs = true
      else if (letter === 'X') o.noExtra = true
      else if (letter === 'y') o.symlinks = true
      else if (letter === '@') o.stdinNames = true
      else if (/[0-9]/.test(letter)) o.level = Number(letter)
      else if (letter === 'x') { target = 'exclude' }
      else if (letter === 'i') { target = 'include' }
      else if (letter === 'v' || letter === 'c' || letter === 'z' || letter === 'o' || letter === 'l' || letter === 'e' || letter === 'T' || letter === 'F' || letter === 'S' || letter === 'A') { /* accepted */ }
      else if (letter === 'h') { out(usage + '\n'); return 0 }
      else { err(`\nzip error: Invalid command arguments (no such option: -${letter})\n`); return 16 }
    }
  }
  if (operands.length === 0) { out(usage + '\n'); return 0 }
  let archive = operands[0]
  const cwd = getcwd()
  if (archive !== '-' && !exists(resolve(cwd, archive)) && !/\.[^/]*$/.test(archive)) archive += '.zip'
  const archivePath = archive === '-' ? undefined : resolve(cwd, archive)
  let existing = []
  let comment = ''
  let existingBytes
  if (archivePath && exists(archivePath)) {
    try {
      existingBytes = readFileBytes(archivePath)
      if (existingBytes.length > 0) {
        const parsed = readZip(existingBytes)
        existing = carry(existingBytes, parsed)
        comment = parsed.comment
      }
    } catch (error) {
      if (error instanceof ZipError) { err(`\nzip error: Zip file structure invalid (${archive})\n`); return 3 }
      err(`\nzip error: Could not open ${archive}: ${reasonOf(error)}\n`)
      return 15
    }
  }
  let names = operands.slice(1)
  if (o.stdinNames) names.push(...new TextDecoder().decode(readFdBytes(0)).split('\n').filter(Boolean))
  const patternMatches = (patterns, name) => patterns.some(pattern => { const match = compilePattern(pattern); return match(name) || match(name.split('/').pop()) })
  const keep = name => (o.excludes.length === 0 || !patternMatches(o.excludes, name)) && (o.includes.length === 0 || patternMatches(o.includes, name))

  if (o.delete) {
    const matchers = names.map(name => compilePattern(name))
    const remaining = existing.filter(entry => !matchers.some(match => match(entry.name) || match(entry.name.replace(/\/$/, ''))))
    const removed = existing.filter(entry => !remaining.includes(entry))
    if (removed.length === 0) { err('\nzip error: Nothing to do! (' + archive + ')\n'); return 12 }
    if (!o.quiet) for (const entry of removed) out(`deleting: ${entry.name}\n`)
    if (remaining.length === 0 && archivePath) { try { unlink(archivePath) } catch { /* left */ } return 0 }
    const bytes = assemble(remaining, comment)
    if (archivePath) writeFileBytes(archivePath, bytes); else writeFdBytes(1, bytes)
    return 0
  }

  const added = []
  const entries = [...existing]
  let warnings = 0
  const add = async (diskName, storedName, isStdin) => {
    let s
    let bytes
    if (isStdin) { bytes = readFdBytes(0); s = { mode: 0o100600, mtimeMs: Date.now(), atimeMs: Date.now(), uid: 0, gid: 0 } }
    else {
      const path = resolve(cwd, diskName)
      try { s = lstat(path) } catch { err(`\tzip warning: name not matched: ${diskName}\n`); warnings++; return }
      if (!o.symlinks && (s.mode & 0o170000) === 0o120000) { try { s = stat(path) } catch { err(`\tzip warning: name not matched: ${diskName}\n`); warnings++; return } }
    }
    const isDir = !isStdin && (s.mode & 0o170000) === 0o040000
    let name = storedName
    if (isDir && !name.endsWith('/')) name += '/'
    if (!keep(name.replace(/\/$/, ''))) return
    if (isDir && (o.noDirs || o.junk)) { if (o.recurse) await descend(diskName, storedName); return }
    const previous = entries.findIndex(entry => entry.name === name)
    if ((o.update || o.freshen) && previous >= 0) {
      if (s.mtimeMs <= entries[previous].mtimeMs + 1999) { if (o.recurse && isDir) await descend(diskName, storedName); return }
    } else if (o.freshen && previous < 0) return
    if (!isStdin && !isDir) {
      try {
        if ((s.mode & 0o170000) === 0o120000) bytes = encoder.encode(readlink(resolve(cwd, diskName)))
        else bytes = readFileBytes(resolve(cwd, diskName))
      } catch (error) { err(`\tzip warning: could not open for reading: ${diskName}\n`); warnings++; return }
    }
    const entry = await makeEntry({ name, data: isDir ? new Uint8Array() : bytes, mtimeMs: Math.floor(s.mtimeMs / 2000) * 2000 + (s.mtimeMs % 2000 >= 1000 ? 0 : 0), mode: s.mode & 0o7777 | (isDir ? 0o040000 : (s.mode & 0o170000) === 0o120000 ? 0o120000 : 0o100000), isDir, level: o.level, atimeMs: s.atimeMs, uid: s.uid ?? 0, gid: s.gid ?? 0, noExtra: o.noExtra })
    entry.mtimeMs = s.mtimeMs
    if (previous >= 0) entries[previous] = entry
    else entries.push(entry)
    added.push({ entry, replaced: previous >= 0, diskName, isDir })
    if (!o.quiet) {
      const percent = entry.method === 8 ? Math.round((1 - entry.compressedSize / Math.max(1, entry.size)) * 100) : 0
      out(`${previous >= 0 ? 'updating' : '  adding'}: ${name} (${entry.method === 8 ? 'deflated' : 'stored'} ${percent}%)\n`)
    }
    if (isDir && o.recurse) await descend(diskName, storedName)
  }
  const descend = async (diskName, storedName) => {
    let children = []
    try { children = readdir(resolve(cwd, diskName)).map(e => (typeof e === 'string' ? e : e.name)).filter(n => n !== '.' && n !== '..').sort() } catch { /* nothing */ }
    for (const child of children) {
      const path = `${diskName.replace(/\/+$/, '')}/${child}`
      await add(path, `${storedName.replace(/\/+$/, '')}/${child}`)
    }
  }
  for (const name of names) {
    if (name === '-') { await add('-', '-', true); continue }
    let stored = name.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
    if (stored === '') stored = '.'
    if (o.junk) stored = stored.replace(/\/+$/, '').split('/').pop()
    // a name with wildcards that the shell did not expand
    if (/[*?[]/.test(name) && !exists(resolve(cwd, name))) {
      const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.'
      const match = compilePattern(name.split('/').pop())
      let any = false
      let listed = []
      try { listed = readdir(resolve(cwd, dir)).map(e => (typeof e === 'string' ? e : e.name)).filter(n => n !== '.' && n !== '..').sort() } catch { /* none */ }
      for (const child of listed) if (match(child)) { any = true; const path = dir === '.' ? child : `${dir}/${child}`; await add(path, o.junk ? child : path) }
      if (!any) { err(`\tzip warning: name not matched: ${name}\n`); warnings++ }
      continue
    }
    await add(name, stored)
  }
  if (added.length === 0 && !(o.update || o.freshen)) {
    err(`\nzip error: Nothing to do! (${archive})\n`)
    return 12
  }
  if (added.length === 0) return 0
  const bytes = assemble(entries, comment)
  if (archivePath) writeFileBytes(archivePath, bytes)
  else writeFdBytes(1, bytes)
  if (o.move) {
    for (const { diskName, isDir } of added.reverse()) { try { isDir ? rmdir(resolve(cwd, diskName)) : unlink(resolve(cwd, diskName)) } catch { /* left */ } }
  }
  return warnings ? 18 : 0
}

try {
  exit(await main())
} catch (error) {
  err(`\nzip error: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(3)
}
