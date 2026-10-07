/**
 * `~/.ssh/known_hosts`: the machines this user has connected to, and the key each one proved it had. One per line,
 * `host:port ecdsa-p384 <public key as JSON, base64>`. `connect` writes it; so does `mount -t ecmaos`.
 */

import { publicKeyOf } from '@ecmaos/peer'
import type { PublicKey } from '@ecmaos/peer'

export const KNOWN_HOSTS_FILE = '.ssh/known_hosts'

/** The key remembered for `id` (`host:port`), or `null` */
export function findKnownHost(text: string, id: string): PublicKey | null {
  for (const line of text.split('\n')) {
    const [host, algorithm, body] = line.trim().split(/\s+/)
    if (host !== id || algorithm !== 'ecdsa-p384' || !body) continue
    try {
      const key = publicKeyOf(JSON.parse(atob(body)))
      if (key) return key
    } catch { /* a line this cannot read is not a known host */ }
  }
  return null
}

/** The line to add for a host seen for the first time */
export function knownHostLine(id: string, key: PublicKey): string {
  return `${id} ecdsa-p384 ${btoa(JSON.stringify({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }))}\n`
}
