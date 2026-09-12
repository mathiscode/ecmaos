/**
 * Real `execve`'d `awk` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/awk.ts`) per `feat/1.0.0-execve-commands`. See `cat.mjs`'s doc comment
 * for why there's no in-band interrupt handling and no `/dev`-path special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: awk [OPTION]... 'program' [FILE]...
Pattern scanning and text processing language.

  -F, --field-separator=FS   set field separator (default: whitespace)
  -v, --assign=VAR=VAL        assign variable VAR to value VAL
  --help                     display this help and exit

Basic usage:
  awk '{ print $1 }' file              Print first field of each line
  awk '/pattern/ { print }' file        Print lines matching pattern
  awk 'BEGIN { print "start" } { print } END { print "end" }' file

Variables:
  $0    whole line
  $1, $2, ...  field numbers
  NR    record number (line number)
  NF    number of fields`

function readWholeFile(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return bytes
}

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    if (n < chunkSize) break
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parseAwkProgram(program) {
  const result = {}

  const beginMatch = program.match(/BEGIN\s*\{([^}]*)\}/)
  if (beginMatch) {
    result.begin = (beginMatch[1] ?? '').split(';').map(s => s.trim()).filter(s => s)
  }

  const endMatch = program.match(/END\s*\{([^}]*)\}/)
  if (endMatch) {
    result.end = (endMatch[1] ?? '').split(';').map(s => s.trim()).filter(s => s)
  }

  const mainMatch = program.match(/(?:BEGIN\s*\{[^}]*\})?\s*([^}]*?)\s*(?:\{([^}]*)\})?\s*(?:END\s*\{[^}]*\})?/)
  if (!mainMatch) {
    const simpleMatch = program.match(/\{([^}]*)\}/)
    if (simpleMatch) {
      result.action = (simpleMatch[1] ?? '').trim()
    } else {
      return null
    }
  } else {
    const patternPart = mainMatch[1]?.trim()
    const actionPart = mainMatch[2]?.trim()

    if (patternPart && !patternPart.startsWith('{')) {
      if (patternPart.startsWith('/') && patternPart.endsWith('/')) {
        result.pattern = patternPart.slice(1, -1)
      } else {
        result.pattern = patternPart
      }
    }

    if (actionPart) {
      result.action = actionPart
    } else if (!patternPart) {
      result.action = 'print'
    }
  }

  if (!result.action && !result.begin && !result.end) return null

  return result
}

function splitFields(line, fs) {
  if (fs === ' ') return line.trim().split(/\s+/)
  return line.split(fs)
}

function executeAction(action, fields, line, NR, NF) {
  if (!action || action.trim() === 'print' || action.trim() === '') return line

  const printMatch = action.match(/print\s+(.+)/)
  if (printMatch) {
    const args = (printMatch[1] ?? '').trim()
    const parts = args.split(',').map(s => s.trim())
    const output = []

    for (const part of parts) {
      if (part === '$0') {
        output.push(line)
      } else if (part.match(/^\$\d+$/)) {
        const fieldNum = parseInt(part.slice(1), 10)
        if (fieldNum >= 1 && fieldNum <= fields.length) output.push(fields[fieldNum - 1] || '')
      } else if (part === 'NR') {
        output.push(String(NR))
      } else if (part === 'NF') {
        output.push(String(NF))
      } else if (part.startsWith('"') && part.endsWith('"')) {
        output.push(part.slice(1, -1))
      } else if (part.startsWith("'") && part.endsWith("'")) {
        output.push(part.slice(1, -1))
      } else {
        output.push(part)
      }
    }

    return output.join(' ')
  }

  return line
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let fieldSeparator = ' '
  const positional = []
  let program

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      write(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-F' || arg === '--field-separator') {
      if (i + 1 < args.length) fieldSeparator = args[++i] || ' '
    } else if (arg.startsWith('--field-separator=')) {
      fieldSeparator = arg.slice(18)
    } else if (arg.startsWith('-F')) {
      fieldSeparator = arg.slice(2) || ' '
    } else if (arg === '-v' || arg === '--assign') {
      if (i + 1 < args.length) i++ // parsed for compatibility, unused (matches the original)
    } else if (arg.startsWith('--assign=') || arg.startsWith('-v')) {
      // no-op: see above
    } else if (!arg.startsWith('-')) {
      if (!program && (arg.startsWith("'") || arg.startsWith('"'))) {
        program = arg.slice(1, -1)
      } else if (!program) {
        program = arg
      } else {
        positional.push(arg)
      }
    }
  }

  if (!program) {
    write(2, new TextEncoder().encode("awk: program is required\nTry 'awk --help' for more information.\n"))
    return 1
  }

  const parsedProgram = parseAwkProgram(program)
  if (!parsedProgram) {
    write(2, new TextEncoder().encode('awk: invalid program\n'))
    return 1
  }

  let lines = []

  if (positional.length === 0) {
    const content = new TextDecoder().decode(readAllStdin())
    lines = content.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
  } else {
    const cwd = getcwd()
    for (const file of positional) {
      const fullPath = resolve(cwd, file)
      try {
        const content = new TextDecoder().decode(readWholeFile(fullPath))
        const fileLines = content.split('\n')
        if (fileLines[fileLines.length - 1] === '') fileLines.pop()
        lines.push(...fileLines)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        write(2, new TextEncoder().encode(`awk: ${file}: ${message}\n`))
      }
    }
  }

  let output = ''

  if (parsedProgram.begin) {
    for (const stmt of parsedProgram.begin) {
      if (stmt.trim() === 'print' || stmt.trim().startsWith('print ')) {
        const result = executeAction(stmt, [], '', 0, 0)
        if (result) output += result + '\n'
      }
    }
  }

  let NR = 0
  for (const line of lines) {
    NR++
    const fields = splitFields(line, fieldSeparator)
    const NF = fields.length

    let shouldProcess = true
    if (parsedProgram.pattern) {
      try {
        shouldProcess = new RegExp(parsedProgram.pattern).test(line)
      } catch {
        shouldProcess = false
      }
    }

    if (shouldProcess && parsedProgram.action) {
      const result = executeAction(parsedProgram.action, fields, line, NR, NF)
      if (result !== null) output += result + '\n'
    } else if (shouldProcess && !parsedProgram.action && !parsedProgram.pattern) {
      output += line + '\n'
    }
  }

  if (parsedProgram.end) {
    for (const stmt of parsedProgram.end) {
      if (stmt.trim() === 'print' || stmt.trim().startsWith('print ')) {
        const result = executeAction(stmt, [], '', NR + 1, 0)
        if (result) output += result + '\n'
      }
    }
  }

  write(1, new TextEncoder().encode(output))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`awk: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
