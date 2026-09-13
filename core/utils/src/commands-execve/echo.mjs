/**
 * Real `execve`'d `echo` -- migrated off `Kernel.executeCommand`'s legacy main-thread `Process`
 * (`core/utils/src/commands/echo.ts`) onto a real, worker-isolated `Thread`, per the
 * `feat/1.0.0-execve-commands` plan. Business logic (flag parsing, backslash-escape
 * interpretation) is unchanged from the original; only the execution shape and I/O are different --
 * real `argv`/`exit`/`write` syscalls instead of a `ctx`/`io` object closing over live `kernel`/
 * `shell`/`terminal` references.
 *
 * The original's `terminal.writeAll(output)` fallback for `!ctx.process` is dropped: a real `execve`'d
 * program always has a process (there is no other way to reach this file), so that branch never ran.
 */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

function interpretEscapes(text) {
  let result = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      switch (next) {
        case '\\': result += '\\'; i += 2; break
        case 'a': result += '\x07'; i += 2; break
        case 'b': result += '\b'; i += 2; break
        case 'c': return result
        case 'e': case 'E': result += '\x1b'; i += 2; break
        case 'f': result += '\f'; i += 2; break
        case 'n': result += '\n'; i += 2; break
        case 'r': result += '\r'; i += 2; break
        case 't': result += '\t'; i += 2; break
        case 'v': result += '\v'; i += 2; break
        case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
          let octal = ''
          let j = i + 1
          while (j < text.length && j < i + 4 && /[0-7]/.test(text[j])) { octal += text[j]; j++ }
          if (octal) { result += String.fromCharCode(parseInt(octal, 8)); i = j } else { result += text[i]; i++ }
          break
        }
        case 'x': {
          let hex = ''
          let j = i + 2
          while (j < text.length && j < i + 4 && /[0-9a-fA-F]/.test(text[j])) { hex += text[j]; j++ }
          if (hex) { result += String.fromCharCode(parseInt(hex, 16)); i = j } else { result += text[i]; i++ }
          break
        }
        default: result += text[i]; i++; break
      }
    } else {
      result += text[i]
      i++
    }
  }
  return result
}

const usage = `Usage: echo [OPTION]... [STRING]...
Echo the STRING(s) to standard output.

  -e     enable interpretation of backslash escapes
  -n     do not output the trailing newline
  --help display this help and exit`

function main() {
  const args = argv.slice(1) // argv[0] is the program path itself

  if (args.length === 0) {
    writeAll(1, new TextEncoder().encode('\n'))
    return 0
  }

  let noNewline = false
  let enableEscapes = false
  const textParts = []

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-n') {
      noNewline = true
    } else if (arg === '-e') {
      enableEscapes = true
    } else if (arg.startsWith('-') && arg.length > 1 && arg !== '--') {
      const flags = arg.slice(1).split('')
      if (flags.includes('n')) noNewline = true
      if (flags.includes('e')) enableEscapes = true
      const invalidFlag = flags.find(f => f !== 'n' && f !== 'e')
      if (invalidFlag) {
        writeAll(1, new TextEncoder().encode(`echo: invalid option -- '${invalidFlag}'\n`))
        return 1
      }
    } else {
      textParts.push(arg)
    }
  }

  let text = textParts.join(' ')
  if (enableEscapes) text = interpretEscapes(text)
  const output = noNewline ? text : text + '\n'

  writeAll(1, new TextEncoder().encode(output))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`echo: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
