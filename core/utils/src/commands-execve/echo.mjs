/** Print arguments to stdout, with optional backslash-escape interpretation. */

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
  -E     disable interpretation of backslash escapes (default)
  -n     do not output the trailing newline
  --help display this help and exit`

/**
 * Whether `arg` is an option bundle echo recognizes: a leading `-` followed by at least one
 * character, all of which are `n`, `e`, or `E`. Anything else that merely starts with `-` is an
 * ordinary operand, not an error -- bash and POSIX both print `---`, `-x`, and `-n-` literally,
 * because echo has no way to report a usage error without corrupting its own output stream.
 */
function isOptionBundle(arg) {
  return arg.length > 1 && arg[0] === '-' && [...arg.slice(1)].every(f => f === 'n' || f === 'e' || f === 'E')
}

function main() {
  const args = argv.slice(1) // argv[0] is the program path itself

  if (args.length === 0) {
    writeAll(1, new TextEncoder().encode('\n'))
    return 0
  }

  let noNewline = false
  let enableEscapes = false
  const textParts = []
  // Options stop at the first operand, as in bash: `echo hello -n` prints "hello -n" rather than
  // treating the trailing `-n` as a flag.
  let parsingOptions = true

  for (const arg of args) {
    if (parsingOptions && (arg === '--help' || arg === '-h')) {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    }

    if (parsingOptions && isOptionBundle(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === 'n') noNewline = true
        else if (flag === 'e') enableEscapes = true
        else if (flag === 'E') enableEscapes = false
      }
      continue
    }

    parsingOptions = false
    textParts.push(arg)
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
