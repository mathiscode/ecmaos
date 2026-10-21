/**
 * `/etc/hosts`: names this machine answers for itself, before any lookup goes out. One entry per line, `ADDRESS NAME [ALIAS...]`,
 * `#` starts a comment. Names are case-insensitive.
 */

export const DEFAULT_HOSTS = '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n'

/**
 * `/etc/services`: the names of well-known ports, `NAME PORT/PROTOCOL [ALIAS...]`, which a C library reads for
 * `getservbyname` and `getnameinfo` (musl's does; an emscripten program has the same names built into its host)
 */
export const DEFAULT_SERVICES = [
  ['ftp', 21], ['ssh', 22], ['telnet', 23], ['smtp', 25], ['domain', 53], ['http', 80], ['pop3', 110], ['ntp', 123],
  ['imap', 143], ['https', 443], ['imaps', 993], ['pop3s', 995]
].map(([name, port]) => `${name}\t${port}/tcp\n${name}\t${port}/udp\n`).join('')

const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

/** Whether `text` is a dotted-quad IPv4 address (each part 0 to 255) */
export function isIPv4(text: string): boolean {
  return ipv4.test(text) && text.split('.').every(part => Number(part) <= 255)
}

/** The addresses `/etc/hosts` gives for `name` in `family` (4 or 6), in file order */
export function lookupHosts(text: string, name: string, family: 4 | 6): string[] {
  const wanted = name.toLowerCase().replace(/\.$/, '')
  const found: string[] = []
  for (const line of text.split('\n')) {
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/)
    if (!address || names.length === 0) continue
    const isV4 = isIPv4(address)
    if (isV4 ? family !== 4 : (family !== 6 || !address.includes(':'))) continue
    if (names.some(entry => entry.toLowerCase() === wanted)) found.push(address)
  }
  return found
}
