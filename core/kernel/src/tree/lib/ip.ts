/**
 * IP addresses as text and as bytes, for the socket layer. An address is always carried as 16 bytes (an IPv4 address as the
 * IPv4-mapped IPv6 address `::ffff:a.b.c.d`, which is also how a dual-stack Linux socket shows one), and as text in one canonical
 * spelling: dotted quad for IPv4 (mapped addresses included), RFC 5952 for IPv6 (lower case, the longest run of zero groups as
 * `::`). No imports, so the `/bin/wali` worker bundle can use it too.
 */

const ZERO_MAPPED = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]

/** 4 bytes for a dotted quad, or `undefined` */
export function parseIPv4(text: string): Uint8Array | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!match) return undefined
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = Number(match[i + 1])
    if (part > 255) return undefined
    out[i] = part
  }
  return out
}

/** 16 bytes for an IPv6 address (`::`, embedded IPv4 tails, and a `%zone` suffix, which is dropped), or `undefined` */
export function parseIPv6(input: string): Uint8Array | undefined {
  const text = input.includes('%') ? input.slice(0, input.indexOf('%')) : input
  if (!text.includes(':')) return undefined
  const double = text.indexOf('::')
  if (double !== text.lastIndexOf('::')) return undefined
  const groupsOf = (part: string): number[] | undefined => {
    if (part === '') return []
    const groups: number[] = []
    const pieces = part.split(':')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIPv4(piece)
        if (!v4) return undefined
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!)
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined
        groups.push(parseInt(piece, 16))
      }
    }
    return groups
  }
  let groups: number[]
  if (double === -1) {
    const all = groupsOf(text)
    if (!all || all.length !== 8) return undefined
    groups = all
  } else {
    const head = groupsOf(text.slice(0, double))
    const tail = groupsOf(text.slice(double + 2))
    if (!head || !tail || head.length + tail.length > 7) return undefined
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail]
  }
  const out = new Uint8Array(16)
  groups.forEach((group, i) => { out[i * 2] = group >> 8; out[i * 2 + 1] = group & 0xff })
  return out
}

/** 16 bytes for any IP address (an IPv4 address comes back mapped), or `undefined` for something that is not one */
export function parseIp(text: string): Uint8Array | undefined {
  const v4 = parseIPv4(text)
  if (v4) {
    const out = new Uint8Array(16)
    out.set(ZERO_MAPPED)
    out.set(v4, 12)
    return out
  }
  return parseIPv6(text)
}

/** Whether `bytes` (16) is an IPv4-mapped address */
export function isMapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 12; i++) if (bytes[i] !== ZERO_MAPPED[i]) return false
  return true
}

/** The canonical text of 16 bytes: dotted quad when it is IPv4-mapped, else RFC 5952 */
export function formatIp(bytes: Uint8Array): string {
  if (isMapped(bytes)) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`
  const groups: number[] = []
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!)
  let bestStart = -1
  let bestLength = 0
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue }
    let end = i
    while (end < 8 && groups[end] === 0) end++
    if (end - i > bestLength) { bestStart = i; bestLength = end - i }
    i = end
  }
  if (bestLength < 2) return groups.map(group => group.toString(16)).join(':')
  const head = groups.slice(0, bestStart).map(group => group.toString(16)).join(':')
  const tail = groups.slice(bestStart + bestLength).map(group => group.toString(16)).join(':')
  return `${head}::${tail}`
}

/** One spelling for an address, so two spellings of it compare equal; `undefined` if `text` is not an address */
export function canonicalIp(text: string): string | undefined {
  const bytes = parseIp(text)
  return bytes ? formatIp(bytes) : undefined
}

/** Whether canonical `address` is an IPv6 address that is not an IPv4-mapped one */
export function isIPv6(address: string): boolean { return address.includes(':') }

/** This machine: `127.0.0.1` and `::1`, and `0.0.0.0` and `::` (what connecting to "any" means on Linux). Not the rest of `127/8`. */
export function isLoopbackIp(address: string): boolean {
  return address === '127.0.0.1' || address === '0.0.0.0' || address === '::1' || address === '::'
}

/** The address a program sees for traffic from this machine: `::1` when it was sent to `::1`, else `127.0.0.1` */
export function loopbackLike(address: string): string { return address.includes(':') ? '::1' : '127.0.0.1' }
