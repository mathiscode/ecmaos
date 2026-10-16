/** `factor`: print the prime factors of each number, from the arguments or from standard input. Any size: BigInt arithmetic. */

import { readFdBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`factor: ${text}\n`))

const usage = `Usage: factor [OPTION] [NUMBER]...
Print the prime factors of each specified integer NUMBER.  If none
are specified on the command line, read them from standard input.

  -h, --exponents   print repeated factors in form p^e unless e is 1
      --help        display this help and exit`

const SMALL_PRIMES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]

function modPow(base, exponent, modulus) {
  let result = 1n
  base %= modulus
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus
    exponent >>= 1n
    base = (base * base) % modulus
  }
  return result
}

function isPrime(n) {
  if (n < 2n) return false
  for (const p of SMALL_PRIMES) { if (n === p) return true; if (n % p === 0n) return false }
  let d = n - 1n
  let s = 0
  while ((d & 1n) === 0n) { d >>= 1n; s++ }
  for (const a of SMALL_PRIMES) {
    let x = modPow(a, d, n)
    if (x === 1n || x === n - 1n) continue
    let composite = true
    for (let i = 1; i < s; i++) {
      x = (x * x) % n
      if (x === n - 1n) { composite = false; break }
    }
    if (composite) return false
  }
  return true
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a }

/** Pollard's rho (Brent's variant) for a composite `n` with no small factors */
function rho(n) {
  if (n % 2n === 0n) return 2n
  for (let c = 1n; ; c++) {
    let x = 2n, y = 2n, d = 1n
    const f = v => (v * v + c) % n
    while (d === 1n) {
      x = f(x)
      y = f(f(y))
      d = gcd(x > y ? x - y : y - x, n)
    }
    if (d !== n) return d
  }
}

function factorize(n) {
  const factors = []
  const split = m => {
    if (m === 1n) return
    if (isPrime(m)) { factors.push(m); return }
    const d = rho(m)
    split(d)
    split(m / d)
  }
  for (let p = 2n; p < 1000n && p * p <= n; p += p === 2n ? 1n : 2n) {
    while (n % p === 0n) { factors.push(p); n /= p }
  }
  split(n)
  return factors.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'h', long: { exponents: 'h', help: 'help', version: 'version' }, permute: true })
  if (error) { err(error); err("Try 'factor --help' for more information."); return 1 }
  let exponents = false
  for (const [key] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'h') exponents = true
  }
  let tokens = operands
  if (tokens.length === 0) tokens = new TextDecoder().decode(readFdBytes(0)).split(/\s+/).filter(Boolean)
  let status = 0
  for (const token of tokens) {
    if (!/^\+?\d+$/.test(token)) { err(`‘${token}’ is not a valid positive integer`); status = 1; continue }
    const n = BigInt(token)
    const factors = n < 2n ? [] : factorize(n)
    let text
    if (exponents) {
      const parts = []
      for (let i = 0; i < factors.length;) {
        let j = i
        while (j < factors.length && factors[j] === factors[i]) j++
        parts.push(j - i > 1 ? `${factors[i]}^${j - i}` : String(factors[i]))
        i = j
      }
      text = parts.join(' ')
    } else text = factors.join(' ')
    out(`${n}:${text ? ' ' + text : ''}\n`)
  }
  return status
}

try {
  exit(main())
} catch (e) {
  err(e?.message ?? String(e))
  exit(1)
}
