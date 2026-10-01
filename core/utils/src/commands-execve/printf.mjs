/** Format and print arguments according to a printf-style format string. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const usage = `Usage: printf FORMAT [ARGUMENT]...
Format and print ARGUMENT(s) according to FORMAT.

FORMAT controls the output as in C printf.  Interpreted sequences:

  \\\\     backslash
  \\a      alert (BEL)
  \\b      backspace
  \\c      produce no further output
  \\e      escape
  \\f      form feed
  \\n      new line
  \\r      carriage return
  \\t      horizontal tab
  \\v      vertical tab
  \\0NNN   byte with octal value NNN (1 to 3 digits)
  \\xHH    byte with hexadecimal value HH (1 to 2 digits)

Conversion specifiers:

  %b      ARGUMENT as a string with '\\' escapes interpreted
  %c      ARGUMENT as a single character
  %d      ARGUMENT as a signed decimal integer
  %i      ARGUMENT as a signed decimal integer
  %o      ARGUMENT as an unsigned octal number
  %s      ARGUMENT as a string
  %u      ARGUMENT as an unsigned decimal integer
  %x      ARGUMENT as an unsigned hexadecimal number (lowercase)
  %X      ARGUMENT as an unsigned hexadecimal number (uppercase)
  %%      a single %

  --help  display this help and exit`

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
        case 'e':
        case 'E': result += '\x1b'; i += 2; break
        case 'f': result += '\f'; i += 2; break
        case 'n': result += '\n'; i += 2; break
        case 'r': result += '\r'; i += 2; break
        case 't': result += '\t'; i += 2; break
        case 'v': result += '\v'; i += 2; break
        case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
          let octal = ''
          let j = i + 1
          while (j < text.length && j < i + 4) {
            const char = text[j]
            if (char && /[0-7]/.test(char)) { octal += char; j++ } else break
          }
          if (octal) { result += String.fromCharCode(parseInt(octal, 8)); i = j } else { result += text[i]; i++ }
          break
        }
        case 'x': {
          let hex = ''
          let j = i + 2
          while (j < text.length && j < i + 4) {
            const char = text[j]
            if (char && /[0-9a-fA-F]/.test(char)) { hex += char; j++ } else break
          }
          if (hex) { result += String.fromCharCode(parseInt(hex, 16)); i = j } else { result += text[i]; i++ }
          break
        }
        default: result += text[i]; i++
      }
    } else {
      result += text[i]
      i++
    }
  }

  return result
}

function formatValue(format, value) {
  switch (format) {
    case '%b': return interpretEscapes(value)
    case '%c': {
      const num = parseInt(value, 10)
      if (!isNaN(num)) return String.fromCharCode(num)
      return value[0] || ''
    }
    case '%d':
    case '%i': {
      const num = parseInt(value, 10)
      return isNaN(num) ? '0' : num.toString()
    }
    case '%o': {
      const num = parseInt(value, 10)
      return isNaN(num) ? '0' : num.toString(8)
    }
    case '%s': return value
    case '%u': {
      const num = parseInt(value, 10)
      if (isNaN(num)) return '0'
      return (num >>> 0).toString()
    }
    case '%x': {
      const num = parseInt(value, 10)
      return isNaN(num) ? '0' : (num >>> 0).toString(16)
    }
    case '%X': {
      const num = parseInt(value, 10)
      return isNaN(num) ? '0' : (num >>> 0).toString(16).toUpperCase()
    }
    case '%%': return '%'
    default: return format
  }
}

/** One conversion's text, before padding: precision cuts a string and pads a number with zeros. */
function convert(conversion, value, flags, precision) {
  if (conversion === 's' || conversion === 'b' || conversion === 'c') {
    const text = formatValue(`%${conversion}`, value)
    return precision === undefined ? text : text.slice(0, precision)
  }
  if ('fFeEgG'.includes(conversion)) {
    const num = parseFloat(value)
    const n = isNaN(num) ? 0 : num
    const digits = precision ?? 6
    const text = conversion === 'f' || conversion === 'F' ? n.toFixed(digits)
      : conversion === 'e' || conversion === 'E' ? n.toExponential(digits).replace(/e([+-])(\d)$/, 'e$10$2')
      : String(Number(n.toPrecision(digits || 1)))
    const out = conversion === 'E' || conversion === 'G' ? text.toUpperCase() : text
    return sign(out, n < 0, flags)
  }
  let text = formatValue(`%${conversion}`, value)
  const negative = text.startsWith('-')
  if (negative) text = text.slice(1)
  if (precision !== undefined && text.length < precision) text = text.padStart(precision, '0')
  if (flags.includes('#') && conversion === 'x' && text !== '0') text = '0x' + text
  if (flags.includes('#') && conversion === 'X' && text !== '0') text = '0X' + text
  if (flags.includes('#') && conversion === 'o' && !text.startsWith('0')) text = '0' + text
  return sign(negative ? '-' + text : text, negative, flags, 'diu'.includes(conversion))
}

/** A `+` or space flag puts a sign on a non-negative number. */
function sign(text, negative, flags, numeric = true) {
  if (!numeric || negative || text.startsWith('-')) return text
  return flags.includes('+') ? '+' + text : flags.includes(' ') ? ' ' + text : text
}

/** Pads to `width`; zero padding goes after a sign, space padding before it. */
function pad(text, width, left, zero) {
  if (text.length >= width) return text
  if (left) return text.padEnd(width)
  if (!zero) return text.padStart(width)
  const signed = /^[-+ ]/.test(text) ? text[0] : ''
  return signed + text.slice(signed.length).padStart(width - signed.length, '0')
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    writeAll(2, new TextEncoder().encode("printf: missing format string\nTry 'printf --help' for more information.\n"))
    return 1
  }

  const format = args[0]
  const values = args.slice(1)

  /**
   * One pass over the format, consuming arguments from `argIndex` onward.
   *
   * A specifier with no argument left formats an empty value (`%s` gives nothing, the numeric ones
   * give `0`), which is what POSIX requires; printing the specifier text itself was wrong.
   */
  const formatOnce = (argIndex) => {
    let result = ''
    let i = 0
    let consumed = argIndex
    let sawSpecifier = false

    while (i < format.length) {
      if (format[i] === '%' && i + 1 < format.length) {
        const next = format[i + 1]
        if (next === '%') {
          result += '%'
          i += 2
          continue
        }
        // %[flags][width][.precision]conversion, where width and precision may be `*` (taken from an argument)
        const spec = /^%([-+ 0#]*)(\d+|\*)?(?:\.(\d*|\*))?([bcdioxXsufFeEgG])/.exec(format.slice(i))
        if (spec) {
          sawSpecifier = true
          const [text, flags = '', widthSpec, precisionSpec, conversion] = spec
          const take = () => values[consumed++] ?? ''
          let width = widthSpec === '*' ? parseInt(take(), 10) || 0 : widthSpec ? parseInt(widthSpec, 10) : 0
          const precision = precisionSpec === '*' ? parseInt(take(), 10) || 0 : precisionSpec === undefined ? undefined : parseInt(precisionSpec || '0', 10)
          let left = flags.includes('-')
          if (width < 0) { left = true; width = -width }
          result += pad(convert(conversion, take(), flags, precision), width, left, flags.includes('0') && !left && !'sbc'.includes(conversion))
          i += text.length
          continue
        }
        sawSpecifier = true
        result += formatValue(`%${next}`, values[consumed] ?? '')
        consumed++
        i += 2
        continue
      }

      if (format[i] === '\\' && i + 1 < format.length) {
        const match = format.slice(i).match(/^\\([\\abceEfnrtv]|x[0-9a-fA-F]{1,2}|0[0-7]{1,3})/)
        if (match) {
          result += interpretEscapes(match[0])
          i += match[0].length
          continue
        }
      }

      result += format[i]
      i++
    }

    return { result, consumed, sawSpecifier }
  }

  // POSIX reuses the format until the arguments run out, so `printf '[%s]\n' a b` prints two lines.
  // A format with no specifiers consumes nothing, so it is printed exactly once and the extra
  // arguments are ignored rather than looping forever.
  let out = ''
  let argIndex = 0
  for (;;) {
    const { result, consumed, sawSpecifier } = formatOnce(argIndex)
    out += result
    if (!sawSpecifier || consumed <= argIndex) break
    argIndex = consumed
    if (argIndex >= values.length) break
  }

  writeAll(1, new TextEncoder().encode(out))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`printf: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
