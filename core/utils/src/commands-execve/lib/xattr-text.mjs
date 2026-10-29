/**
 * How `getfattr` shows an extended attribute's value and `setfattr` reads one, as the attr package's tools do: a quoted
 * string with `\ooo` escapes (`text`), `0x` and hex digits (`hex`), or `0s` and base64 (`base64`).
 */

/** Whether a value reads as text: printable bytes, tabs and newlines, with at most a trailing NUL */
function looksLikeText(bytes) {
  const end = bytes.length && bytes[bytes.length - 1] === 0 ? bytes.length - 1 : bytes.length
  for (let i = 0; i < end; i++) {
    const byte = bytes[i]
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false
    if (byte === 0x7f) return false
  }
  return true
}

function base64Of(bytes) {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

/**
 * `value` in `encoding` (`text`, `hex` or `base64`); with none, as text when it reads as text and base64 when it does
 * not, as getfattr does when `-e` is not given.
 */
export function encodeValue(bytes, encoding) {
  const as = encoding ?? (looksLikeText(bytes) ? 'text' : 'base64')
  if (as === 'hex') return '0x' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  if (as === 'base64') return '0s' + base64Of(bytes)
  let text = '"'
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) text += '\\' + String.fromCharCode(byte)
    else if (byte < 0x20 || byte >= 0x7f) text += '\\' + byte.toString(8).padStart(3, '0')
    else text += String.fromCharCode(byte)
  }
  return text + '"'
}

/** The bytes `setfattr -v` means by `text`: `0x` hex, `0s` base64, a quoted string with escapes, or the text as it is */
export function decodeValue(text) {
  if (/^0[xX]/.test(text)) {
    const digits = text.slice(2)
    if (!/^([0-9a-fA-F]{2})*$/.test(digits)) throw new Error('bad input encoding')
    return Uint8Array.from(digits.match(/../g) ?? [], pair => parseInt(pair, 16))
  }
  if (/^0[sS]/.test(text)) {
    let binary
    try { binary = atob(text.slice(2)) } catch { throw new Error('bad input encoding') }
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  }
  if (text.startsWith('"')) {
    const body = text.endsWith('"') && text.length > 1 ? text.slice(1, -1) : text.slice(1)
    const bytes = []
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== '\\') { bytes.push(...new TextEncoder().encode(body[i])); continue }
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))
      if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue }
      if (i + 1 < body.length) bytes.push(...new TextEncoder().encode(body[++i]))
    }
    return Uint8Array.from(bytes)
  }
  return new TextEncoder().encode(text)
}

/** A path in a `# file:` line, as getfattr writes it: backslashes, newlines and other control bytes escaped in octal */
export function quotePath(path) {
  return path.replace(/[\\\x00-\x1f\x7f]/g, char => '\\' + char.charCodeAt(0).toString(8).padStart(3, '0'))
}

/** The path a `# file:` line names */
export function unquotePath(text) {
  return text.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
}
