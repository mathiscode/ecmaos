/**
 * A SIZE argument as GNU coreutils read it (`split -b 10K`, `head -c 1M`): digits and an optional multiplier, where
 * `K M G T P E Z Y` (also `KiB`...) are powers of 1024, `KB MB GB`... are powers of 1000, and `b` is 512. Returns the
 * number of bytes, or `undefined` for text that is no size.
 */

const POWERS = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6, Z: 7, Y: 8 }

export function parseSize(text, { blocks = true } = {}) {
  const match = /^(\d+)([a-zA-Z]*)$/.exec(text)
  if (!match) return undefined
  const [, digits, suffix] = match
  const value = BigInt(digits)
  if (suffix === '') return Number(value)
  if (blocks && suffix === 'b') return Number(value * 512n)
  const base = /^[KMGTPEZY]B$/i.test(suffix) && suffix.length === 2 ? 1000n : /^[KMGTPEZY](iB)?$/i.test(suffix) ? 1024n : undefined
  if (base === undefined) return undefined
  const letter = suffix[0].toUpperCase()
  // `kB` is a thousand, `K` and `KiB` are 1024
  return Number(value * base ** BigInt(POWERS[letter]))
}
