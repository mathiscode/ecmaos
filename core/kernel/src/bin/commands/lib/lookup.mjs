/** Name lookups and reachability for `host`, `nslookup`, `dig` and `ping`: `/etc/hosts`, then the gateway's resolver (`dns_lookup`). */

import { readBackAndDelete, scratchPath } from './scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls

/**
 * The addresses of `name` for one family (4 or 6): `{ addresses }`, or `{ error: 'NONAME' | 'AGAIN', message }`. A literal
 * address answers as itself. With no gateway up a name that is not in `/etc/hosts` is `AGAIN`.
 */
export async function lookup(name, family) {
  const path = scratchPath('dns')
  await syscalls.custom('dns_lookup', name, family, path)
  return JSON.parse(await readBackAndDelete(syscalls, path))
}

/** Both families: `{ v4, v6, error }`; `error` is set only when neither family answered */
export async function lookupBoth(name) {
  const [v4, v6] = await Promise.all([lookup(name, 4), lookup(name, 6)])
  const found = { v4: v4.addresses ?? [], v6: v6.addresses ?? [] }
  if (found.v4.length || found.v6.length) return found
  return { ...found, error: v4.error === 'AGAIN' || v6.error === 'AGAIN' ? v4.error === 'AGAIN' ? v4 : v6 : v4 }
}

/** A TCP connection to `host:port` through the gateway, closed at once: `{ ok: true, address }` or `{ ok: false, error, message }` */
export async function probe(host, port) {
  const path = scratchPath('probe')
  await syscalls.custom('net_connect_out', host, port, 'tcp', path)
  const result = JSON.parse(await readBackAndDelete(syscalls, path))
  if (result.error) return { ok: false, error: result.error, message: result.message ?? result.error }
  try { syscalls.close(result.fd) } catch { /* closed already */ }
  try { syscalls.close(result.writeFd) } catch { /* closed already */ }
  return { ok: true, address: result.address }
}

export const isIPv4 = text => /^\d{1,3}(\.\d{1,3}){3}$/.test(text)
export const isIPv6 = text => text.includes(':') && /^[0-9a-fA-F:.]+$/.test(text)
