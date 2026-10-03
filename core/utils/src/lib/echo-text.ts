/**
 * What `echo` prints for its arguments, shared by the `/bin/echo` program and the shells' builtin so
 * the two cannot drift. Options stop at the first operand, as in bash (`echo hi -n` prints `hi -n`),
 * and an argument that merely starts with `-` but is not made of `n`, `e` and `E` is an ordinary operand.
 */

function interpretEscapes(text: string): { text: string, stop: boolean } {
  let result = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1] as string
      switch (next) {
        case '\\': result += '\\'; i += 2; break
        case 'a': result += '\x07'; i += 2; break
        case 'b': result += '\b'; i += 2; break
        case 'c': return { text: result, stop: true }
        case 'e': case 'E': result += '\x1b'; i += 2; break
        case 'f': result += '\f'; i += 2; break
        case 'n': result += '\n'; i += 2; break
        case 'r': result += '\r'; i += 2; break
        case 't': result += '\t'; i += 2; break
        case 'v': result += '\v'; i += 2; break
        case '0': {
          // \0nnn: a zero and up to three octal digits (a bare \nnn is not an escape in echo)
          let octal = ''
          let j = i + 2
          while (j < text.length && j < i + 5 && /[0-7]/.test(text[j] as string)) { octal += text[j]; j++ }
          result += String.fromCharCode(octal ? parseInt(octal, 8) : 0)
          i = j
          break
        }
        case 'x': {
          let hex = ''
          let j = i + 2
          while (j < text.length && j < i + 4 && /[0-9a-fA-F]/.test(text[j] as string)) { hex += text[j]; j++ }
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
  return { text: result, stop: false }
}

/** Whether `arg` is an option bundle echo recognizes: `-` then only `n`, `e` or `E`. */
function isOptionBundle(arg: string): boolean {
  return arg.length > 1 && arg[0] === '-' && [...arg.slice(1)].every(flag => flag === 'n' || flag === 'e' || flag === 'E')
}

/** The exact text `echo ARGS...` writes to standard output. */
export function echoOutput(args: string[], options: { stopAtHelp?: boolean } = {}): { output: string, help: boolean } {
  let noNewline = false
  let escapes = false
  const parts: string[] = []
  let parsingOptions = true
  for (const arg of args) {
    if (parsingOptions && options.stopAtHelp && (arg === '--help' || arg === '-h')) return { output: '', help: true }
    if (parsingOptions && isOptionBundle(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === 'n') noNewline = true
        else if (flag === 'e') escapes = true
        else if (flag === 'E') escapes = false
      }
      continue
    }
    parsingOptions = false
    parts.push(arg)
  }
  let text = parts.join(' ')
  let stop = false
  if (escapes) ({ text, stop } = interpretEscapes(text))
  return { output: text + (noNewline || stop ? '' : '\n'), help: false }
}
