/**
 * Convert tabs to spaces, as GNU `expand` does: tab stops every 8 columns, or `-t N` / `-t LIST`; `-i` converts only the tabs
 * at the start of a line. A character is a column (UTF-8), a backspace takes one back, and past the last stop in a list a tab is
 * one space.
 */

import { resolve } from './lib/path-utils.mjs'
import { nextStop, parseTabs, startsCharacter } from './lib/tabs.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`expand: ${text}\n`))

const usage = `Usage: expand [OPTION]... [FILE]...
Convert tabs in each FILE to spaces, writing to standard output. With no FILE, or when FILE is -, read standard input.

  -i, --initial    do not convert tabs after non blanks
  -t, --tabs=N     have tabs N characters apart, not 8
  -t, --tabs=LIST  use comma separated list of tab positions; the last specified position can be prefixed with '/' to specify a tab size to use after the last explicitly specified tab stop
  --help           display this help and exit`

const decode = bytes => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return text }

function readFd(fd) {
  const chunks = []
  let total = 0
  for (;;) {
    const buffer = new Uint8Array(65536)
    const n = read(fd, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    total += n
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return bytes
}

function main() {
  const args = argv.slice(1)
  let tabs = { every: 8 }
  let initial = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--initial') { initial = true; continue }
    const long = /^--tabs(?:=(.*))?$/.exec(arg)
    const short = /^-t(.*)$/.exec(arg)
    if (long || short) {
      const text = long ? (long[1] !== undefined ? long[1] : args[++i]) : (short[1] !== '' ? short[1] : args[++i])
      const parsed = parseTabs(text)
      if (parsed.error) { err(parsed.error); return 1 }
      tabs = parsed
      continue
    }
    // The obsolete `-4` for `-t 4`
    if (/^-\d+$/.test(arg)) { tabs = { every: Number(arg.slice(1)) }; continue }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'expand --help' for more information."); return 1 }
    for (const flag of arg.slice(1)) {
      if (flag === 'i') initial = true
      else { err(`invalid option -- '${flag}'`); err("Try 'expand --help' for more information."); return 1 }
    }
  }

  const expandLine = line => {
    let out = ''
    let column = 0
    let leading = true
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]
      const code = line.charCodeAt(k)
      if (ch === '\t' && (!initial || leading)) {
        const stop = nextStop(tabs, column)
        const width = stop === undefined ? 1 : stop - column
        out += ' '.repeat(width)
        column += width
        continue
      }
      if (ch !== ' ' && ch !== '\t') leading = false
      out += ch
      if (ch === '\b') column = column > 0 ? column - 1 : 0
      else if (ch === '\t') column = nextStop(tabs, column) ?? column + 1
      else if (startsCharacter(code)) column++
    }
    return out
  }

  const cwd = getcwd()
  let failed = false
  if (files.length === 0) files.push('-')
  for (const file of files) {
    try {
      let bytes
      if (file === '-') bytes = readFd(0)
      else {
        const fullPath = resolve(cwd, file)
        if (isDirectory(fullPath)) { err(`${file}: read error: Is a directory`); failed = true; continue }
        const fd = open(fullPath, O_RDONLY)
        try { bytes = readFd(fd) } finally { close(fd) }
      }
      const text = decode(bytes)
      const out = text.split('\n').map(expandLine).join('\n')
      writeAll(1, Uint8Array.from(out, ch => ch.charCodeAt(0)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      err(`${file}: ${/ENOENT/.test(message) ? 'No such file or directory' : /EACCES/.test(message) ? 'Permission denied' : message}`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
