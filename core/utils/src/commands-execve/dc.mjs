/**
 * `dc`: the reverse-polish desk calculator. Arbitrary-precision decimal arithmetic on BigInt, a stack of numbers and
 * strings, registers and register stacks, arrays, macros, and the input, output and scale radixes.
 */

import { getopt } from './lib/getopt.mjs'
import { readFdText, readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`dc: ${text}\n`))

const usage = `Usage: dc [OPTION] [file ...]
  -e, --expression=EXPR    evaluate expression
  -f, --file=FILE          evaluate contents of file
  -h, --help               display this help and exit
  -V, --version            output version information and exit

Reads standard input when there is no -e, -f or file.`

const pow10 = n => 10n ** BigInt(n)
const rescale = (x, s) => (s >= x.s ? { v: x.v * pow10(s - x.s), s } : { v: x.v / pow10(x.s - s), s })
const isNumber = x => typeof x === 'object' && x !== null && 'v' in x

class Quit extends Error {
  constructor(levels) { super('quit'); this.levels = levels }
}

const state = { stack: [], regs: new Map(), arrays: new Map(), scale: 0, ibase: 10, obase: 10, stdin: undefined }

function isqrt(n) {
  if (n < 2n) return n
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1)
  while (true) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

function pop() {
  if (!state.stack.length) throw new Error('stack empty')
  return state.stack.pop()
}
function popNumber() {
  const x = pop()
  if (!isNumber(x)) throw new Error('non-numeric value')
  return x
}
const toInt = x => rescale(x, 0).v

function divide(a, b, scale) {
  if (b.v === 0n) throw new Error('divide by zero')
  return { v: (a.v * pow10(scale + b.s)) / (b.v * pow10(a.s)), s: scale }
}

const binary = {
  '+'(a, b) { const s = Math.max(a.s, b.s); return { v: rescale(a, s).v + rescale(b, s).v, s } },
  '-'(a, b) { const s = Math.max(a.s, b.s); return { v: rescale(a, s).v - rescale(b, s).v, s } },
  '*'(a, b) { return rescale({ v: a.v * b.v, s: a.s + b.s }, Math.min(a.s + b.s, Math.max(state.scale, a.s, b.s))) },
  '/'(a, b) { return divide(a, b, state.scale) },
  '%'(a, b) { return remainder(a, b).r },
  '^'(a, b) {
    const n = toInt(b)
    const positive = { v: a.v ** (n < 0n ? -n : n), s: a.s * Number(n < 0n ? -n : n) }
    if (n >= 0n) return rescale(positive, Math.min(positive.s, Math.max(state.scale, a.s)))
    return divide({ v: 1n, s: 0 }, positive, state.scale)
  }
}

function remainder(a, b) {
  if (b.v === 0n) throw new Error('remainder by zero')
  const q = divide(a, b, state.scale)
  const s = Math.max(a.s, b.s + state.scale)
  const product = { v: q.v * b.v, s: q.s + b.s }
  return { q, r: { v: rescale(a, s).v - rescale(product, s).v, s } }
}

function parseNumber(code, at) {
  let i = at
  let negative = false
  if (code[i] === '_') { negative = true; i++ }
  let whole = ''
  let frac = ''
  let dot = false
  for (; i < code.length; i++) {
    const c = code[i]
    if (c === '.' && !dot) { dot = true; continue }
    if (/[0-9A-F]/.test(c)) { if (dot) frac += c; else whole += c } else break
  }
  const digit = c => parseInt(c, 16)
  const base = BigInt(state.ibase)
  let intPart = 0n
  for (const c of whole) intPart = intPart * base + BigInt(digit(c))
  let v
  if (state.ibase === 10) v = BigInt((whole || '0') + frac)
  else {
    let fracPart = 0n
    for (const c of frac) fracPart = fracPart * base + BigInt(digit(c))
    v = intPart * pow10(frac.length) + (fracPart * pow10(frac.length)) / base ** BigInt(frac.length)
  }
  return { number: { v: negative ? -v : v, s: frac.length }, next: i }
}

const GLYPHS = '0123456789ABCDEF'
function radixDigits(n, base) {
  if (n === 0n) return base > 16 ? [0] : [0]
  const digits = []
  while (n > 0n) { digits.unshift(Number(n % BigInt(base))); n /= BigInt(base) }
  return digits
}
const glyph = (digit, base) => (base <= 16 ? GLYPHS[digit] : ' ' + String(digit).padStart(String(base - 1).length, '0'))

function format(x, base) {
  if (!isNumber(x)) return x
  const negative = x.v < 0n
  const magnitude = negative ? -x.v : x.v
  const unit = pow10(x.s)
  const whole = magnitude / unit
  let fraction = magnitude % unit
  let text
  if (base === 10) {
    const frac = x.s ? fraction.toString().padStart(x.s, '0') : ''
    text = (whole === 0n && x.s ? '' : whole.toString()) + (x.s ? '.' + frac : '')
    if (text === '') text = '0'
  } else {
    text = whole === 0n && x.s ? '' : radixDigits(whole, base).map(d => glyph(d, base)).join('')
    if (x.s) {
      let digits = ''
      for (let i = 0; i < x.s; i++) {
        fraction *= BigInt(base)
        digits += glyph(Number(fraction / unit), base)
        fraction %= unit
      }
      text += (base > 16 ? ' .' : '.') + digits
    }
    if (text === '') text = '0'
  }
  return (negative ? '-' : '') + text
}

/** dc folds a long number at 69 columns, ending each line with a backslash */
function wrap(text) {
  if (text.length <= 70) return text
  const lines = []
  for (let i = 0; i < text.length; i += 69) lines.push(text.slice(i, i + 69))
  return lines.join('\\\n')
}

function getRegister(name) {
  let reg = state.regs.get(name)
  if (!reg) { reg = []; state.regs.set(name, reg) }
  return reg
}

/** `a` is the top of the stack, `b` the value beneath it: `>` is true when the top is the greater */
function compare(op, a, b) {
  const s = Math.max(a.s, b.s)
  const x = rescale(a, s).v
  const y = rescale(b, s).v
  switch (op) {
    case '=': return x === y
    case '!=': return x !== y
    case '<': return x < y
    case '>': return x > y
    case '!<': return !(x < y)
    case '!>': return !(x > y)
  }
  return false
}

function run(source, depth) {
  let code = source
  let i = 0
  while (i < code.length) {
    const c = code[i]
    try {
      if (/\s/.test(c)) { i++; continue }
      if (c === '#') { while (i < code.length && code[i] !== '\n') i++; continue }
      if (/[0-9A-F._]/.test(c)) {
        const { number, next } = parseNumber(code, i)
        state.stack.push(number)
        i = next
        continue
      }
      i++
      switch (c) {
        case '[': {
          let level = 1
          let text = ''
          for (; i < code.length; i++) {
            if (code[i] === '\\' && i + 1 < code.length) { text += code[++i]; continue }
            if (code[i] === '[') level++
            if (code[i] === ']' && --level === 0) break
            text += code[i]
          }
          i++
          state.stack.push(text)
          break
        }
        case '+': case '-': case '*': case '/': case '%': case '^': {
          const b = popNumber()
          const a = popNumber()
          state.stack.push(binary[c](a, b))
          break
        }
        case '~': {
          const b = popNumber()
          const a = popNumber()
          const { q, r } = remainder(a, b)
          state.stack.push(q, r)
          break
        }
        case '|': {
          const modulus = toInt(popNumber())
          const exponent = toInt(popNumber())
          const base = toInt(popNumber())
          if (modulus === 0n) throw new Error('remainder by zero')
          if (exponent < 0n) throw new Error('negative exponent')
          let result = 1n
          let b = ((base % modulus) + modulus) % modulus
          for (let e = exponent; e > 0n; e >>= 1n) { if (e & 1n) result = (result * b) % modulus; b = (b * b) % modulus }
          state.stack.push({ v: result, s: 0 })
          break
        }
        case 'v': {
          const a = popNumber()
          if (a.v < 0n) throw new Error('square root of negative number')
          const s = Math.max(state.scale, a.s)
          state.stack.push({ v: isqrt(a.v * pow10(2 * s - a.s)), s })
          break
        }
        case 'p': { const top = state.stack[state.stack.length - 1]; if (top === undefined) throw new Error('stack empty'); out((isNumber(top) ? wrap(format(top, state.obase)) : top) + '\n'); break }
        case 'n': { const top = pop(); out(isNumber(top) ? wrap(format(top, state.obase)) : top); break }
        case 'P': {
          const top = pop()
          if (isNumber(top)) { const n = toInt(top); writeAll(1, new Uint8Array([Number(((n % 256n) + 256n) % 256n)])) } else out(top)
          break
        }
        case 'f': for (let j = state.stack.length - 1; j >= 0; j--) { const x = state.stack[j]; out((isNumber(x) ? wrap(format(x, state.obase)) : x) + '\n') } break
        case 'c': state.stack.length = 0; break
        case 'd': { const top = state.stack[state.stack.length - 1]; if (top === undefined) throw new Error('stack empty'); state.stack.push(top); break }
        case 'r': { const b = pop(); const a = pop(); state.stack.push(b, a); break }
        case 'R': pop(); break
        case 'k': { const n = Number(toInt(popNumber())); if (n < 0) throw new Error('scale must be a nonnegative number'); state.scale = n; break }
        case 'K': state.stack.push({ v: BigInt(state.scale), s: 0 }); break
        case 'i': { const n = Number(toInt(popNumber())); if (n < 2 || n > 16) throw new Error('input base must be a number between 2 and 16'); state.ibase = n; break }
        case 'I': state.stack.push({ v: BigInt(state.ibase), s: 0 }); break
        case 'o': { const n = Number(toInt(popNumber())); if (n < 2) throw new Error('output base must be a number greater than 1'); state.obase = n; break }
        case 'O': state.stack.push({ v: BigInt(state.obase), s: 0 }); break
        case 'z': state.stack.push({ v: BigInt(state.stack.length), s: 0 }); break
        case 'Z': { const x = pop(); state.stack.push({ v: BigInt(isNumber(x) ? (x.v < 0n ? -x.v : x.v).toString().length : x.length), s: 0 }); break }
        case 'X': { const x = pop(); state.stack.push({ v: BigInt(isNumber(x) ? x.s : 0), s: 0 }); break }
        case 'a': { const x = pop(); state.stack.push(isNumber(x) ? String.fromCharCode(Number(((toInt(x) % 256n) + 256n) % 256n)) : x.slice(0, 1)); break }
        case 's': { const name = code[i++]; getRegister(name)[0] = pop(); break }
        case 'l': {
          const name = code[i++]
          const reg = getRegister(name)
          if (reg.length === 0 || reg[reg.length - 1] === undefined) { if (reg.length === 0) reg.push(undefined); state.stack.push({ v: 0n, s: 0 }) } else state.stack.push(reg[reg.length - 1])
          break
        }
        case 'S': getRegister(code[i++]).push(pop()); break
        case 'L': { const reg = getRegister(code[i++]); if (!reg.length) throw new Error('stack register is empty'); state.stack.push(reg.pop()); break }
        case ':': { const name = code[i++]; const index = Number(toInt(popNumber())); const value = pop(); let arr = state.arrays.get(name); if (!arr) state.arrays.set(name, (arr = new Map())); arr.set(index, value); break }
        case ';': { const name = code[i++]; const index = Number(toInt(popNumber())); state.stack.push(state.arrays.get(name)?.get(index) ?? { v: 0n, s: 0 }); break }
        case 'x': case '>': case '<': case '=': case '!': {
          let target
          if (c === 'x') target = pop()
          else {
            let op = c
            if (c === '!') {
              if (!'<>='.includes(code[i])) { while (i < code.length && code[i] !== '\n') i++; break }
              op = '!' + code[i++]
            }
            const name = code[i++]
            const b = popNumber()
            const a = popNumber()
            if (!compare(op, b, a)) break
            const reg = getRegister(name)
            target = reg[reg.length - 1]
            if (target === undefined) break
          }
          if (!isNumber(target) && typeof target === 'string') {
            if (/^\s*$/.test(code.slice(i))) { code = target; i = 0 } else run(target, depth + 1)
          } else if (isNumber(target)) state.stack.push(target)
          break
        }
        case '?': { const line = readLine(); if (line !== undefined) run(line, depth + 1); break }
        case 'q': throw new Quit(depth > 0 ? 2 : 1)
        case 'Q': { const n = Number(toInt(popNumber())); if (n < 1) throw new Error('Q command requires a number >= 1'); throw new Quit(n) }
        default: err(`'${c}' (0${c.charCodeAt(0).toString(8)}) unimplemented`)
      }
    } catch (error) {
      if (error instanceof Quit) {
        if (depth === 0) throw error
        if (error.levels > 1) throw new Quit(error.levels - 1)
        return
      }
      err(error instanceof Error ? error.message : String(error))
    }
  }
}

function readLine() {
  if (state.stdin === undefined) state.stdin = readFdText(0)
  if (!state.stdin.length) return undefined
  const at = state.stdin.indexOf('\n')
  const line = at === -1 ? state.stdin : state.stdin.slice(0, at)
  state.stdin = at === -1 ? '' : state.stdin.slice(at + 1)
  return line
}

function main() {
  const parsed = getopt(argv.slice(1), {
    short: 'e:f:hV',
    long: { expression: { key: 'e', arg: 'required' }, file: { key: 'f', arg: 'required' }, help: 'h', version: 'V' }
  })
  if (parsed.error) { err(parsed.error); out(usage + '\n'); return 1 }
  if (parsed.options.some(([key]) => key === 'h')) { out(usage + '\n'); return 0 }
  if (parsed.options.some(([key]) => key === 'V')) { out('dc (ecmaOS coreutils)\n'); return 0 }

  const sources = []
  for (const [key, value] of parsed.options) {
    if (key === 'e') sources.push(value)
    if (key === 'f') sources.push({ file: value })
  }
  for (const operand of parsed.operands) sources.push({ file: operand })

  try {
    if (!sources.length) run(readFdText(0), 0)
    for (const source of sources) {
      if (typeof source === 'string') { run(source, 0); continue }
      let text
      try { text = source.file === '-' ? readFdText(0) : readTextFile(source.file) } catch { err(`File ${source.file} is unavailable.`); return 1 }
      run(text, 0)
    }
  } catch (error) {
    if (!(error instanceof Quit)) throw error
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
