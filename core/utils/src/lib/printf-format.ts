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

/** A byte from an escape: 0x80 and up cannot be a character of the text (it would be written as UTF-8), so it is marked in the private-use block and `printfBytes` turns it back into the byte. */
const RAW_BASE = 0xf700
function rawByte(value: number): string {
  return String.fromCharCode(value >= 0x80 ? RAW_BASE + value : value)
}

/** The bytes `formatPrintf`'s result stands for: text as UTF-8, and each byte an escape named as itself. */
export function printfBytes(text: string): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < RAW_BASE + 0x80 || code > RAW_BASE + 0xff) continue
    if (i > start) parts.push(encoder.encode(text.slice(start, i)))
    parts.push(Uint8Array.of(code - RAW_BASE))
    start = i + 1
  }
  if (start < text.length) parts.push(encoder.encode(text.slice(start)))
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/** `formatPrintf`'s result as a string value (for a shell variable): a byte an escape named is the character with that code. */
export function printfString(text: string): string {
  return text.replace(/[\uf780-\uf7ff]/g, c => String.fromCharCode(c.charCodeAt(0) - RAW_BASE))
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
          if (octal) { result += rawByte(parseInt(octal, 8) & 0xff); i = j } else { result += text[i]; i++ }
          break
        }
        case 'x': {
          let hex = ''
          let j = i + 2
          while (j < text.length && j < i + 4) {
            const char = text[j]
            if (char && /[0-9a-fA-F]/.test(char)) { hex += char; j++ } else break
          }
          if (hex) { result += rawByte(parseInt(hex, 16)); i = j } else { result += text[i]; i++ }
          break
        }
        case 'u': case 'U': {
          const max = next === 'u' ? 4 : 8
          let hex = ''
          let j = i + 2
          while (j < text.length && hex.length < max && /[0-9a-fA-F]/.test(text[j] as string)) { hex += text[j]; j++ }
          const point = parseInt(hex, 16)
          if (hex && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) { result += String.fromCodePoint(point); i = j } else { result += text[i]; i++ }
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


/** What a numeric argument is: decimal, `0x` hex, leading-0 octal, a float, or `'c` / `"c` for a character's code. `ok` is false when it is not a number. */
function parseArgument(value: string): { number: number, big: bigint | undefined, ok: boolean } {
  if (value === '') return { number: 0, big: 0n, ok: true }
  if ((value[0] === "'" || value[0] === '"') && value.length > 1) return { number: value.codePointAt(1) ?? 0, big: BigInt(value.codePointAt(1) ?? 0), ok: true }
  const text = value.trim()
  if (/^[-+]?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)$/.test(text)) {
    const negative = text.startsWith('-')
    const digits = text.replace(/^[-+]/, '')
    const big = BigInt(/^0[0-7]+$/.test(digits) ? '0o' + digits.slice(1) : digits)
    return { number: Number(negative ? -big : big), big: negative ? -big : big, ok: true }
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return { number: Number(text), big: undefined, ok: true }
  if (/^[-+]?(inf(inity)?|nan)$/i.test(text)) return { number: /nan/i.test(text) ? NaN : text.startsWith('-') ? -Infinity : Infinity, big: undefined, ok: true }
  // A number followed by other text is used up to there, and reported
  const lead = /^[-+]?\d+/.exec(text)
  return lead ? { number: Number(lead[0]), big: BigInt(lead[0]), ok: false } : { number: 0, big: 0n, ok: false }
}

/** A finite double as its sign, an integer mantissa and a binary exponent: |x| = mantissa * 2^exponent */
function decompose(x: number): { negative: boolean, mantissa: bigint, exponent: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const high = view.getUint32(0)
  const low = view.getUint32(4)
  const biased = (high >>> 20) & 0x7ff
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low)
  let exponent = -1074
  if (biased !== 0) { mantissa |= 1n << 52n; exponent = biased - 1075 }
  return { negative: (high >>> 31) === 1, mantissa, exponent }
}

/** |x| * 10^k as an integer, rounded to even on an exact tie, which is what C's printf does and `toFixed` does not */
function scaledRound(mantissa: bigint, exponent: number, k: number): bigint {
  let numerator = mantissa
  let denominator = 1n
  if (exponent >= 0) numerator <<= BigInt(exponent)
  else denominator <<= BigInt(-exponent)
  if (k >= 0) numerator *= 10n ** BigInt(k)
  else denominator *= 10n ** BigInt(-k)
  let quotient = numerator / denominator
  const twice = (numerator % denominator) * 2n
  if (twice > denominator || (twice === denominator && (quotient & 1n) === 1n)) quotient += 1n
  return quotient
}

/** C's `%.Nf` of a finite number, exact for any size and rounding ties to even */
export function toFixedC(x: number, digits: number): string {
  const { negative, mantissa, exponent } = decompose(x)
  const text = scaledRound(mantissa, exponent, digits).toString().padStart(digits + 1, '0')
  const whole = text.slice(0, text.length - digits)
  const out = digits > 0 ? `${whole}.${text.slice(text.length - digits)}` : whole
  return negative ? '-' + out : out
}

/** C's `%.Ne` of a finite number: `d.ddde+XX` with at least two exponent digits */
export function toExponentialC(x: number, digits: number): string {
  const { negative, mantissa, exponent } = decompose(x)
  const sign = negative ? '-' : ''
  if (mantissa === 0n) return `${sign}${(0).toFixed(digits)}e+00`
  let e = Math.floor(Math.log10(Math.abs(x)))
  let q = scaledRound(mantissa, exponent, digits - e)
  const upper = 10n ** BigInt(digits + 1)
  const lower = 10n ** BigInt(digits)
  if (q >= upper) { e++; q = scaledRound(mantissa, exponent, digits - e) }
  else if (q < lower) { e--; q = scaledRound(mantissa, exponent, digits - e) }
  const text = q.toString()
  const body = digits > 0 ? `${text[0]}.${text.slice(1)}` : (text[0] as string)
  return `${sign}${body}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
}

/** C's `%g`: the shorter of `%e` and `%f` for the precision, without trailing zeros (unless `#`) */
function formatGeneral(n: number, precision: number, alternate: boolean): string {
  if (!Number.isFinite(n)) return String(n).replace('Infinity', 'inf').replace('NaN', 'nan')
  const p = precision === 0 ? 1 : precision
  if (n === 0) return alternate ? toFixedC(0, p - 1) : '0'
  const exponent = Number(toExponentialC(n, p - 1).split('e')[1])
  let text: string
  if (exponent < -4 || exponent >= p) {
    text = toExponentialC(n, p - 1)
    if (!alternate) text = text.replace(/\.?0+e/, 'e')
  } else {
    text = toFixedC(n, Math.max(0, p - 1 - exponent))
    if (!alternate && text.includes('.')) text = text.replace(/\.?0+$/, '')
  }
  return text
}

let invalidArgument: ((value: string) => void) | undefined
let badFormat: ((character: string) => void) | undefined

function formatValue(format: string, value: string): string {
  switch (format) {
    case '%b': return interpretEscapes(value)
    case '%c': return value === '' ? '' : String.fromCodePoint(value.codePointAt(0) ?? 0)
    case '%d':
    case '%i': {
      const parsed = parseArgument(value)
      if (!parsed.ok) invalidArgument?.(value)
      return parsed.big !== undefined ? parsed.big.toString() : String(Math.trunc(parsed.number))
    }
    case '%o':
    case '%u':
    case '%x':
    case '%X': {
      const parsed = parseArgument(value)
      if (!parsed.ok) invalidArgument?.(value)
      const unsigned = BigInt.asUintN(64, parsed.big ?? BigInt(Math.trunc(parsed.number) || 0))
      return format === '%o' ? unsigned.toString(8) : format === '%u' ? unsigned.toString() : format === '%X' ? unsigned.toString(16).toUpperCase() : unsigned.toString(16)
    }
    case '%s': return value
    case '%q': return quoteWord(value)
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
    const parsed = parseArgument(value)
    if (!parsed.ok) invalidArgument?.(value)
    const n = parsed.number
    const digits = precision ?? 6
    const text = !Number.isFinite(n) ? String(n).replace('Infinity', 'inf').replace('NaN', 'nan')
      : conversion === 'f' || conversion === 'F' ? toFixedC(n, digits)
      : conversion === 'e' || conversion === 'E' ? toExponentialC(n, digits)
      : formatGeneral(n, digits, flags.includes('#'))
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
export function formatPrintf(format: string, values: string[], onInvalid?: (value: string) => void, onBadFormat?: (character: string) => void): string {
  invalidArgument = onInvalid
  badFormat = onBadFormat
  try { return formatPrintfWith(format, values) } finally { invalidArgument = undefined; badFormat = undefined }
}

function formatPrintfWith(format: string, values: string[]): string {
  /**
   * One pass over the format, consuming arguments from `argIndex`. A specifier with no argument left formats empty
   * (`%s` nothing, numeric ones `0`), as POSIX requires.
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
        // %(FORMAT)T: a time (seconds since the epoch; empty or -1 is now) through strftime
        const timeSpec = /^%(-?\d+)?(?:\.(\d+))?\(([^)]*)\)T/.exec(format.slice(i))
        if (timeSpec) {
          sawSpecifier = true
          const raw = (values[consumed++] ?? '').trim()
          const seconds = raw === '' || raw === '-1' || raw === '-2' ? Date.now() / 1000 : Number(raw)
          let text = Number.isFinite(seconds) ? formatTime(timeSpec[3] as string, seconds * 1000) : ''
          if (timeSpec[2] !== undefined) text = text.slice(0, Number(timeSpec[2]))
          const w = timeSpec[1] ? Number(timeSpec[1]) : 0
          result += pad(text, Math.abs(w), w < 0, false)
          i += timeSpec[0].length
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
        if (badFormat) {
          // bash prints what came before, reports the character and stops
          badFormat(/^%[-+ 0#]*(?:\d+|\*)?(?:\.(?:\d*|\*))?(.)/.exec(format.slice(i))?.[1] ?? (next as string))
          return { result, consumed, sawSpecifier, stop: true }
        }
        result += formatValue(`%${next}`, values[consumed] ?? '')
        consumed++
        i += 2
        continue
      }

      if (format[i] === '\\' && i + 1 < format.length) {
        const match = format.slice(i).match(/^\\([\\abceEfnrtv]|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|0[0-7]{0,3}|[1-7][0-7]{0,2})/)
        if (match) {
          result += interpretEscapes(match[0])
          i += match[0].length
          continue
        }
      }

      result += format[i]
      i++
    }

    return { result, consumed, sawSpecifier, stop: false }
  }

  // POSIX reuses the format until the arguments run out, so `printf '[%s]\n' a b` prints two lines.
  // A format with no specifiers consumes nothing, so it is printed exactly once and the extra
  // arguments are ignored rather than looping forever.
  let out = ''
  let argIndex = 0
  for (;;) {
    const { result, consumed, sawSpecifier, stop } = formatOnce(argIndex)
    out += result
    if (stop) break
    if (!sawSpecifier || consumed <= argIndex) break
    argIndex = consumed
    if (argIndex >= values.length) break
  }


  return out
}


const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The common strftime conversions for `%(FORMAT)T`, in the zone `TZ` names (UTC) or the host's. */
function formatTime(format: string, ms: number): string {
  const utc = /^(UTC|GMT|UCT)(0)?$/.test((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TZ ?? '')
  const d = new Date(ms)
  const get = utc
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), w: d.getUTCDay() }
    : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), w: d.getDay() }
  const p2 = (n: number) => String(n).padStart(2, '0')
  const yearDay = Math.floor((Date.UTC(get.y, get.mo, get.d) - Date.UTC(get.y, 0, 1)) / 86400000) + 1
  const offset = utc ? 0 : -d.getTimezoneOffset()
  const zone = `${offset < 0 ? '-' : '+'}${p2(Math.floor(Math.abs(offset) / 60))}${p2(Math.abs(offset) % 60)}`
  return format.replace(/%([a-zA-Z%])/g, (all, c: string) => {
    switch (c) {
      case 'Y': return String(get.y)
      case 'y': return p2(get.y % 100)
      case 'm': return p2(get.mo + 1)
      case 'd': return p2(get.d)
      case 'e': return String(get.d).padStart(2, ' ')
      case 'H': return p2(get.h)
      case 'I': return p2(get.h % 12 || 12)
      case 'M': return p2(get.mi)
      case 'S': return p2(get.s)
      case 'p': return get.h < 12 ? 'AM' : 'PM'
      case 'j': return String(yearDay).padStart(3, '0')
      case 'a': return (DAYS[get.w] as string).slice(0, 3)
      case 'A': return DAYS[get.w] as string
      case 'b': case 'h': return (MONTHS[get.mo] as string).slice(0, 3)
      case 'B': return MONTHS[get.mo] as string
      case 'u': return String(get.w || 7)
      case 'w': return String(get.w)
      case 's': return String(Math.floor(ms / 1000))
      case 'F': return `${get.y}-${p2(get.mo + 1)}-${p2(get.d)}`
      case 'T': return `${p2(get.h)}:${p2(get.mi)}:${p2(get.s)}`
      case 'R': return `${p2(get.h)}:${p2(get.mi)}`
      case 'D': return `${p2(get.mo + 1)}/${p2(get.d)}/${p2(get.y % 100)}`
      case 'z': return zone
      case 'Z': return utc ? 'UTC' : (new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find(part => part.type === 'timeZoneName')?.value ?? 'UTC')
      case 'n': return '\n'
      case 't': return '\t'
      case '%': return '%'
      default: return all
    }
  })
}
