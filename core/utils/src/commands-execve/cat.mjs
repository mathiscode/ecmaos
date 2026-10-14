/**
 * Concatenate files and print them to stdout, as GNU `cat` does, including `-n`, `-b`, `-s`, `-E`, `-T`, `-v` and their
 * combinations (`-A`, `-e`, `-t`). With no option the bytes are copied as they are read, so a pipe or a device (`/dev/zero`) is
 * streamed and `^C` ends it. `^C` kills the process outright, like a real `cat`.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, isDirectory, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`cat: ${text}\n`))

const usage = `Usage: cat [OPTION]... [FILE]...
Concatenate FILE(s) to standard output. With no FILE, or when FILE is -, read standard input.

  -A, --show-all           equivalent to -vET
  -b, --number-nonblank    number nonempty output lines, overrides -n
  -e                       equivalent to -vE
  -E, --show-ends          display $ at the end of each line
  -n, --number             number all output lines
  -s, --squeeze-blank      suppress repeated empty output lines
  -t                       equivalent to -vT
  -T, --show-tabs          display TAB characters as ^I
  -u                       (ignored)
  -v, --show-nonprinting   use ^ and M- notation, except for LFD and TAB
  --help                   display this help and exit`

const longOptions = {
  '--show-all': 'A', '--number-nonblank': 'b', '--show-ends': 'E', '--number': 'n', '--squeeze-blank': 's', '--show-tabs': 'T', '--show-nonprinting': 'v'
}

/** What a byte is shown as under -v: `^@` for control characters, `^?` for DEL, `M-` before one with the high bit set */
function visible(byte, out) {
  if (byte >= 128) { out.push(0x4d, 0x2d); byte -= 128 }
  if (byte < 32) out.push(0x5e, byte + 64)
  else if (byte === 127) out.push(0x5e, 0x3f)
  else out.push(byte)
}

function main() {
  const args = argv.slice(1)
  const options = new Set()
  const files = []
  let optionsEnded = false

  for (const arg of args) {
    if (!optionsEnded && arg === '--') optionsEnded = true
    else if (!optionsEnded && (arg === '--help' || arg === '-h')) {
      writeAll(1, encoder.encode(usage + '\n'))
      return 0
    } else if (!optionsEnded && longOptions[arg]) options.add(longOptions[arg])
    else if (!optionsEnded && arg.startsWith('--')) {
      err(`unrecognized option '${arg}'`)
      err("Try 'cat --help' for more information.")
      return 1
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      for (const flag of arg.slice(1)) {
        if (flag === 'A') { options.add('v'); options.add('E'); options.add('T') }
        else if (flag === 'e') { options.add('v'); options.add('E') }
        else if (flag === 't') { options.add('v'); options.add('T') }
        else if ('bEnsTv'.includes(flag)) options.add(flag)
        else if (flag === 'u') { /* ignored */ }
        else {
          err(`invalid option -- '${flag}'`)
          err("Try 'cat --help' for more information.")
          return 1
        }
      }
    } else files.push(arg)
  }

  const plain = options.size === 0
  const numberNonblank = options.has('b')
  const numberAll = options.has('n') && !numberNonblank
  const squeeze = options.has('s')
  const showEnds = options.has('E')
  const showTabs = options.has('T')
  const showNonprinting = options.has('v')

  // Line state runs on across files: a last line with no newline is continued by the next file's first line
  const state = { atStart: true, lineNo: 0, previousBlank: false, pendingReturn: false }

  const transform = (chunk, final = false) => {
    const out = []
    // With -E a carriage return right before a line feed is shown as ^M, so one at the end of a chunk waits for the next byte
    const bytes = state.pendingReturn ? Uint8Array.from([13, ...chunk]) : chunk
    state.pendingReturn = false
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]
      if (showEnds && byte === 13) {
        if (i + 1 === bytes.length && !final) { state.pendingReturn = true; continue }
        if (bytes[i + 1] === 10) {
          // The line has begun with this byte; number it first if it is a numbered line
          if (state.atStart) {
            state.previousBlank = false
            if (numberAll || numberNonblank) { for (const digit of String(++state.lineNo).padStart(6)) out.push(digit.charCodeAt(0)); out.push(9) }
            state.atStart = false
          }
          out.push(0x5e, 0x4d)
          continue
        }
      }
      if (state.atStart) {
        // Repeated empty lines after the first are left out
        if (squeeze && byte === 10 && state.previousBlank) continue
        state.previousBlank = byte === 10
        if (numberAll || (numberNonblank && byte !== 10)) {
          for (const digit of String(++state.lineNo).padStart(6)) out.push(digit.charCodeAt(0))
          out.push(9)
        }
        state.atStart = false
      }
      if (byte === 10) {
        if (showEnds) out.push(0x24)
        out.push(10)
        state.atStart = true
      } else if (byte === 9) {
        if (showTabs) out.push(0x5e, 0x49)
        else out.push(9)
      } else if (showNonprinting) visible(byte, out)
      else out.push(byte)
    }
    return Uint8Array.from(out)
  }

  const copy = fd => {
    const buffer = new Uint8Array(65536)
    for (;;) {
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      const chunk = buffer.subarray(0, n)
      writeAll(1, plain ? chunk : transform(chunk))
    }
  }

  /** A carriage return that was waiting for the byte after it, at the very end of the input */
  const finish = () => {
    if (state.pendingReturn) writeAll(1, transform(new Uint8Array(0), true))
  }

  if (files.length === 0) files.push('-')

  const cwd = getcwd()
  let failed = false

  for (const file of files) {
    if (file === '-') { copy(0); continue }
    const fullPath = resolve(cwd, file)
    try {
      if (isDirectory(fullPath)) {
        err(`${file}: Is a directory`)
        failed = true
        continue
      }
      const fd = open(fullPath, O_RDONLY)
      try { copy(fd) } finally { close(fd) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = message.includes('ENOENT') ? 'No such file or directory'
        : message.includes('EACCES') ? 'Permission denied'
        : message
      err(`${file}: ${reason}`)
      failed = true
    }
  }

  finish()
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, encoder.encode(`cat: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
