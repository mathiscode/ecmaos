/**
 * `units`: convert a quantity between units. A unit expression is a number, units multiplied by a space or `*`, divided by
 * `/` or `per`, raised to a power with `^`, a fraction written `1|2`, in parentheses; `tempC(20)` and the like convert
 * temperatures. The units, with the SI prefixes, are built in. Run with no operands it asks `You have:` and `You want:`.
 */

import { getopt } from './lib/getopt.mjs'
import { readFdText } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`${text}\n`))

const usage = `Usage: units [options] ['from-unit' 'to-unit']

  -1, --one-line      print the conversion on one line, as '* FACTOR'
  -t, --terse         print only the conversion factor
  -h, --help          print this help and exit
  -V, --version       print the version and exit

Without operands units asks for "You have" and "You want" until end of input.`

const BASES = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd', 'bit']
const quantity = (factor, dims = {}) => ({ factor, dims })

const PREFIXES = {
  yotta: 1e24, zetta: 1e21, exa: 1e18, peta: 1e15, tera: 1e12, giga: 1e9, mega: 1e6, myria: 1e4, kilo: 1e3, hecto: 1e2, deka: 10, deca: 10,
  deci: 1e-1, centi: 1e-2, milli: 1e-3, micro: 1e-6, nano: 1e-9, pico: 1e-12, femto: 1e-15, atto: 1e-18, zepto: 1e-21, yocto: 1e-24,
  kibi: 1024, mebi: 1024 ** 2, gibi: 1024 ** 3, tebi: 1024 ** 4, pebi: 1024 ** 5, exbi: 1024 ** 6
}
const SHORT_PREFIXES = {
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 10, d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, µ: 1e-6,
  n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18, z: 1e-21, y: 1e-24, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6
}

/** Units defined by an expression over simpler ones; the primitives are listed first. */
const PRIMITIVE = { m: 'm', meter: 'm', metre: 'm', kg: 'kg', s: 's', second: 's', sec: 's', A: 'A', ampere: 'A', amp: 'A', K: 'K', kelvin: 'K', mol: 'mol', mole: 'mol', cd: 'cd', candela: 'cd', bit: 'bit' }
const DEFINED = {
  g: '1e-3 kg', gram: 'g', gm: 'g', tonne: '1000 kg', metricton: 'tonne', t: 'tonne',
  min: '60 s', minute: 'min', hr: '3600 s', hour: 'hr', h: 'hr', day: '24 hr', d: 'day', week: '7 day', fortnight: '14 day',
  year: '365.2425 day', yr: 'year', month: 'year/12', ms: '1e-3 s',
  Hz: '1/s', hertz: 'Hz', N: 'kg m/s^2', newton: 'N', Pa: 'N/m^2', pascal: 'Pa', J: 'N m', joule: 'J', W: 'J/s', watt: 'W',
  C: 'A s', coulomb: 'C', V: 'W/A', volt: 'V', ohm: 'V/A', F: 'C/V', farad: 'F', S: 'A/V', siemens: 'S', Wb: 'V s', weber: 'Wb', T: 'Wb/m^2', tesla: 'T', H: 'Wb/A', henry: 'H',
  pi: '3.14159265358979323846', e: '2.71828182845904523536', c: '299792458 m/s', radian: '1', rad: 'radian', sr: '1', degree: 'pi/180', deg: 'degree', arcmin: 'degree/60', arcsec: 'arcmin/60',
  percent: '0.01', dozen: '12', gross: '144', mole_: 'mol',
  micron: '1e-6 m', angstrom: '1e-10 m', in: '2.54 cm', inch: 'in', ft: '12 in', foot: 'ft', feet: 'ft', yd: '3 ft', yard: 'yd', mi: '5280 ft', mile: 'mi', mil: 'in/1000', furlong: '660 ft', fathom: '6 ft',
  nmi: '1852 m', nauticalmile: 'nmi', au: '149597870700 m', ly: 'c julianyear', lightyear: 'ly', julianyear: '365.25 day', parsec: 'au 648000/pi', pc: 'parsec', point: 'in/72', pica: '12 point',
  lb: '0.45359237 kg', pound: 'lb', oz: 'lb/16', ounce: 'oz', stone: '14 lb', ton: '2000 lb', grain: 'lb/7000', carat: '200 mg', ct: 'carat',
  lbf: 'lb 9.80665 m/s^2', kgf: 'kg 9.80665 m/s^2', dyne: '1e-5 N',
  L: '1e-3 m^3', l: 'L', liter: 'L', litre: 'L', gallon: '231 in^3', gal: 'gallon', quart: 'gallon/4', qt: 'quart', pint: 'quart/2', pt: 'pint', cup: 'pint/2', floz: 'cup/8', tbsp: 'floz/2', tablespoon: 'tbsp', tsp: 'tbsp/3', teaspoon: 'tsp',
  acre: '43560 ft^2', hectare: '1e4 m^2', ha: 'hectare',
  atm: '101325 Pa', atmosphere: 'atm', bar: '1e5 Pa', torr: 'atm/760', mmHg: 'torr', psi: 'lbf/in^2',
  cal: '4.184 J', calorie: 'cal', Cal: '1000 cal', Btu: '1055.056 J', erg: '1e-7 J', eV: '1.602176634e-19 J', electronvolt: 'eV', kWh: 'kilo W hr', therm: '1.05506e8 J',
  hp: '745.69987158227022 W', horsepower: 'hp',
  knot: 'nmi/hr', kt: 'knot', mph: 'mi/hr', kph: 'km/hr', fps: 'ft/s', gee: '9.80665 m/s^2',
  byte: '8 bit', B: 'byte', octet: 'byte', kB: '1000 byte', word: '2 byte',
  gauss: '1e-4 T', Gs: 'gauss', oersted: '1000/(4 pi) A/m', maxwell: '1e-8 Wb',
  celsius_delta: 'K', fahrenheit_delta: '5/9 K', rankine: '5/9 K', degR: 'rankine'
}
// `m` is both the metre and the milli prefix: a bare `m` is the metre, as it is in units
delete DEFINED.mole_

const TEMPERATURES = {
  tempC: [value => value + 273.15, kelvin => kelvin - 273.15],
  tempF: [value => (value + 459.67) * 5 / 9, kelvin => kelvin * 9 / 5 - 459.67],
  tempK: [value => value, kelvin => kelvin],
  tempR: [value => value * 5 / 9, kelvin => kelvin * 9 / 5]
}

const cache = new Map()
const multiply = (a, b) => { const dims = { ...a.dims }; for (const [k, v] of Object.entries(b.dims)) { dims[k] = (dims[k] ?? 0) + v; if (!dims[k]) delete dims[k] } return quantity(a.factor * b.factor, dims) }
const power = (a, n) => { const dims = {}; for (const [k, v] of Object.entries(a.dims)) dims[k] = v * n; return quantity(a.factor ** n, dims) }
const invert = a => power(a, -1)

function lookup(name) {
  if (cache.has(name)) return cache.get(name)
  let result
  if (name in PRIMITIVE) result = quantity(1, { [PRIMITIVE[name]]: 1 })
  else if (name in DEFINED) result = evaluate(DEFINED[name])
  if (result) { cache.set(name, result); return result }
  // a plural: feet is defined, otherwise drop an `s` or `es`
  for (const stem of [name.replace(/ies$/, 'y'), name.replace(/es$/, ''), name.replace(/s$/, '')]) {
    if (stem !== name && stem.length > 1 && (result = lookup(stem))) { cache.set(name, result); return result }
  }
  for (const [prefix, factor] of [...Object.entries(PREFIXES), ...Object.entries(SHORT_PREFIXES)].sort((a, b) => b[0].length - a[0].length)) {
    if (name.length > prefix.length && name.startsWith(prefix) && (result = lookup(name.slice(prefix.length)))) {
      result = quantity(result.factor * factor, result.dims)
      cache.set(name, result)
      return result
    }
  }
  cache.set(name, undefined)
  return undefined
}

function tokenize(text) {
  const tokens = []
  const pattern = /\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\*\*|[*/^()|+-]|[A-Za-zµ_][A-Za-zµ_0-9]*)/y
  let at = 0
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break
    pattern.lastIndex = at
    const match = pattern.exec(text)
    if (!match) throw new Error(`Bad expression: ${text}`)
    tokens.push(match[1])
    at = pattern.lastIndex
  }
  return tokens
}

function evaluate(text) {
  const tokens = tokenize(text)
  let at = 0
  const peek = () => tokens[at]
  const isNumber = token => token !== undefined && /^[\d.]/.test(token)
  const startsOperand = token => token !== undefined && (isNumber(token) || token === '(' || /^[A-Za-zµ_]/.test(token)) && token !== 'per'

  function atom() {
    const token = tokens[at++]
    if (token === undefined) throw new Error('Bad expression: missing operand')
    if (token === '(') { const inner = expression(); if (tokens[at++] !== ')') throw new Error('Bad expression: missing )'); return inner }
    if (token === '-') return multiply(quantity(-1), atom())
    if (token === '+') return atom()
    if (isNumber(token)) {
      let value = Number(token)
      if (peek() === '|') { at++; const denominator = tokens[at++]; if (!isNumber(denominator)) throw new Error('Bad expression: bad fraction'); value /= Number(denominator) }
      return quantity(value)
    }
    if (token in TEMPERATURES && peek() === '(') {
      at++
      const inner = expression()
      if (tokens[at++] !== ')') throw new Error('Bad expression: missing )')
      return quantity(TEMPERATURES[token][0](inner.factor), { K: 1 })
    }
    let found = lookup(token)
    if (!found) {
      const split = /^(.*?)(\d)$/.exec(token)
      if (split && (found = lookup(split[1]))) return power(found, Number(split[2]))
      throw new Error(`Unknown unit '${token}'`)
    }
    return found
  }

  function exponent() {
    let base = atom()
    while (peek() === '^' || peek() === '**') {
      at++
      let sign = 1
      if (peek() === '-') { sign = -1; at++ } else if (peek() === '+') at++
      const n = tokens[at++]
      if (!isNumber(n)) throw new Error('Bad expression: bad exponent')
      base = power(base, sign * Number(n))
    }
    return base
  }

  function term() {
    let value = exponent()
    while (startsOperand(peek())) value = multiply(value, exponent())
    return value
  }

  function expression() {
    let value = term()
    while (peek() === '*' || peek() === '/' || peek() === 'per') {
      const operator = tokens[at++]
      const next = term()
      value = operator === '*' ? multiply(value, next) : multiply(value, invert(next))
    }
    return value
  }

  const result = expression()
  if (at < tokens.length) throw new Error(`Bad expression: unexpected '${tokens[at]}'`)
  return result
}

/** C's `%.8g` */
function general(value) {
  if (value === 0) return '0'
  const exponentOf = Number(value.toExponential(7).split('e')[1])
  if (exponentOf < -4 || exponentOf >= 8) {
    const [mantissa, exp] = value.toExponential(7).split('e')
    const digits = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa
    const n = Number(exp)
    return `${digits}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`
  }
  const fixed = value.toPrecision(8)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

const dimensionText = dims => {
  const names = BASES.filter(base => dims[base])
  return names.length ? names.map(base => (dims[base] === 1 ? base : `${base}^${dims[base]}`)).join(' ') : '1'
}
const sameDims = (a, b) => BASES.every(base => (a[base] ?? 0) === (b[base] ?? 0))

function convert(have, want, style) {
  // a temperature scale as the target: `tempF` alone
  const scale = TEMPERATURES[want.trim()]
  const from = evaluate(have)
  if (scale) {
    if (!sameDims(from.dims, { K: 1 })) return { error: `conformability error\n\t${dimensionText(from.dims)}\n\tK` }
    return { text: style === 'terse' ? general(scale[1](from.factor)) : `\t${general(scale[1](from.factor))}\n` }
  }
  const to = evaluate(want)
  if (!sameDims(from.dims, to.dims)) return { error: `conformability error\n\t${general(from.factor)} ${dimensionText(from.dims)}\n\t${general(to.factor)} ${dimensionText(to.dims)}` }
  const ratio = from.factor / to.factor
  if (style === 'terse') return { text: general(ratio) }
  if (style === 'one') return { text: `\t* ${general(ratio)}\n` }
  return { text: `\t* ${general(ratio)}\n\t/ ${general(1 / ratio)}\n` }
}

function main() {
  const parsed = getopt(argv.slice(1), { short: '1thV', long: { 'one-line': '1', terse: 't', help: 'h', version: 'V' } })
  if (parsed.error) { err(`units: ${parsed.error}`); err(usage); return 3 }
  const flags = new Set(parsed.options.map(([key]) => key))
  if (flags.has('h')) { out(usage + '\n'); return 0 }
  if (flags.has('V')) { out('units (ecmaOS coreutils)\n'); return 0 }
  const style = flags.has('t') ? 'terse' : flags.has('1') ? 'one' : 'full'

  const run = (have, want) => {
    try {
      const result = convert(have, want, style)
      if (result.error) { err(result.error); return 1 }
      out(style === 'terse' ? result.text + '\n' : result.text)
      return 0
    } catch (error) {
      err(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  if (parsed.operands.length === 2) return run(parsed.operands[0], parsed.operands[1])
  if (parsed.operands.length !== 0) { err(usage); return 3 }

  const lines = readFdText(0).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let status = 0
  for (let i = 0; i + 1 < lines.length + 1; i += 2) {
    if (lines[i] === undefined) break
    out('You have: ')
    out('You want: ')
    if (lines[i + 1] === undefined) break
    status = run(lines[i], lines[i + 1])
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(`units: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
