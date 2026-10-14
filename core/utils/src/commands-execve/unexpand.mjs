/**
 * Convert spaces to tabs, as GNU `unexpand` does: only the blanks at the start of a line by default, every run with `-a`
 * (which `-t` implies). A run of blanks becomes a tab where it reaches a tab stop (8 columns, or `-t N` / `-t LIST`); a single
 * space before a stop stays a space, and a tab that was there already stays a tab.
 */

import { resolve } from './lib/path-utils.mjs'
import { nextStop, parseTabs, startsCharacter } from './lib/tabs.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`unexpand: ${text}\n`))

const usage = `Usage: unexpand [OPTION]... [FILE]...
Convert blanks in each FILE to tabs, writing to standard output. With no FILE, or when FILE is -, read standard input.

  -a, --all        convert all blanks, instead of just initial blanks
      --first-only convert only leading sequences of blanks (overrides -a)
  -t, --tabs=N     have tabs N characters apart instead of 8 (enables -a)
  -t, --tabs=LIST  use comma separated LIST of tab positions (enables -a)
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
  let all = false
  let firstOnly = false
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg === '--all') { all = true; continue }
    if (arg === '--first-only') { firstOnly = true; continue }
    const long = /^--tabs(?:=(.*))?$/.exec(arg)
    const short = /^-t(.*)$/.exec(arg)
    if (long || short) {
      const text = long ? (long[1] !== undefined ? long[1] : args[++i]) : (short[1] !== '' ? short[1] : args[++i])
      const parsed = parseTabs(text)
      if (parsed.error) { err(parsed.error); return 1 }
      tabs = parsed
      all = true
      continue
    }
    if (arg.startsWith('--')) { err(`unrecognized option '${arg}'`); err("Try 'unexpand --help' for more information."); return 1 }
    for (const flag of arg.slice(1)) {
      if (flag === 'a') all = true
      else { err(`invalid option -- '${flag}'`); err("Try 'unexpand --help' for more information."); return 1 }
    }
  }
  const convertAll = all && !firstOnly

  const unexpandLine = line => {
    let out = ''
    let column = 0
    let leading = true
    let k = 0
    while (k < line.length) {
      const ch = line[k]
      if ((ch === ' ' || ch === '\t') && (convertAll || leading)) {
        // The run of blanks from here, as columns
        const startColumn = column
        let endColumn = column
        let hasTab = false
        let j = k
        while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
          if (line[j] === '\t') { hasTab = true; endColumn = nextStop(tabs, endColumn) ?? endColumn + 1 } else endColumn++
          j++
        }
        let current = startColumn
        for (;;) {
          const stop = nextStop(tabs, current)
          if (stop === undefined || stop > endColumn) break
          // One blank column alone is not worth a tab, unless a tab was already there
          if (stop - current >= 2 || hasTab) { out += '\t'; current = stop } else break
        }
        out += ' '.repeat(endColumn - current)
        column = endColumn
        k = j
        continue
      }
      if (ch !== ' ' && ch !== '\t') leading = false
      out += ch
      const code = line.charCodeAt(k)
      if (ch === '\b') column = column > 0 ? column - 1 : 0
      else if (ch === '\t') column = nextStop(tabs, column) ?? column + 1
      else if (startsCharacter(code)) column++
      k++
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
      const out = decode(bytes).split('\n').map(unexpandLine).join('\n')
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
