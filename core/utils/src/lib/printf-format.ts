/**
 * `printf` formatting, shared by the `printf` program and the shells' `printf` builtin (which has `-v`, and so has
 * to live in the shell): the C conversions, `%b` and `%q`, widths, precisions and flags, and the escapes in the
 * format. The format is reused until the arguments run out, as POSIX says.
 */

/** A word quoted so a shell reads it back as it is: backslashes, or `$'...'` when it has control characters. */
export function quoteWord(text: string): string {
  if (text === '') return "''"
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) {
    return "$'" + text.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/[\x00-\x1f\x7f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + "'"
  }
  return text.replace(/[^A-Za-z0-9_@%+=:,./-]/g, '\\$&')
}

export function interpretEscapes(text: string): string {
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
          while (j < text.length && j < i + (text[i + 1] === '0' ? 5 : 4)) {
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

function formatValue(format: string, value: string): string {
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
    case '%q': return quoteWord(value)
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
function convert(conversion: string, value: string, flags: string, precision: number | undefined): string {
  if (conversion === 's' || conversion === 'b' || conversion === 'c' || conversion === 'q') {
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
function sign(text: string, negative: boolean, flags: string, numeric = true): string {
  if (!numeric || negative || text.startsWith('-')) return text
  return flags.includes('+') ? '+' + text : flags.includes(' ') ? ' ' + text : text
}

/** Pads to `width`; zero padding goes after a sign, space padding before it. */
function pad(text: string, width: number, left: boolean, zero: boolean): string {
  if (text.length >= width) return text
  if (left) return text.padEnd(width)
  if (!zero) return text.padStart(width)
  const signed = /^[-+ ]/.test(text) ? text.charAt(0) : ''
  return signed + text.slice(signed.length).padStart(width - signed.length, '0')
}


/** `format` filled in from `values`. */
export function formatPrintf(format: string, values: string[]): string {
  /**
   * One pass over the format, consuming arguments from `argIndex` onward.
   *
   * A specifier with no argument left formats an empty value (`%s` gives nothing, the numeric ones
   * give `0`), which is what POSIX requires; printing the specifier text itself was wrong.
   */
  const formatOnce = (argIndex: number) => {
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
        const spec = /^%([-+ 0#]*)(\d+|\*)?(?:\.(\d*|\*))?([bcdioqxXsufFeEgG])/.exec(format.slice(i))
        if (spec) {
          sawSpecifier = true
          const [text, flags = '', widthSpec, precisionSpec, conversion = 's'] = spec
          const take = () => values[consumed++] ?? ''
          let width = widthSpec === '*' ? parseInt(take(), 10) || 0 : widthSpec ? parseInt(widthSpec, 10) : 0
          const precision = precisionSpec === '*' ? parseInt(take(), 10) || 0 : precisionSpec === undefined ? undefined : parseInt(precisionSpec || '0', 10)
          let left = flags.includes('-')
          if (width < 0) { left = true; width = -width }
          result += pad(convert(conversion, take(), flags, precision), width, left, flags.includes('0') && !left && !'sbcq'.includes(conversion))
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
        const match = format.slice(i).match(/^\\([\\abceEfnrtv]|x[0-9a-fA-F]{1,2}|0[0-7]{0,3})/)
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


  return out
}
