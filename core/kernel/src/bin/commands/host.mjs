/** Look up the addresses of a name: `host example.com`. */

import { getopt } from './lib/getopt.mjs'
import { isIPv4, isIPv6, lookupBoth } from './lib/lookup.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: host [-4] [-6] [-t TYPE] NAME
Look up the addresses of NAME.

  -4        IPv4 addresses only
  -6        IPv6 addresses only
  -t TYPE   A or AAAA (the only records the resolver gives)
  --help    display this help and exit

The name is looked up in /etc/hosts, then by the gateway's resolver (gateway up). Without a gateway only
/etc/hosts answers. Reverse lookups and other record types are not available.`

async function main() {
  const parsed = getopt(argv.slice(1), { flags: '46v', values: 't', long: {} })
  if (parsed.error) { err(`host: ${parsed.error}`); return 1 }
  if (parsed.opts.help) { out(usage + '\n'); return 0 }
  const [name] = parsed.rest
  if (!name) { err(usage.split('\n')[0]); return 1 }
  const type = (parsed.opts.t ?? '').toUpperCase()
  if (type && type !== 'A' && type !== 'AAAA') { err(`host: ${type} records are not available; only A and AAAA`); return 1 }
  if (isIPv4(name) || isIPv6(name)) { err('host: reverse lookups are not available'); return 1 }

  const found = await lookupBoth(name)
  const v4 = parsed.opts['6'] || type === 'AAAA' ? [] : found.v4
  const v6 = parsed.opts['4'] || type === 'A' ? [] : found.v6
  if (!v4.length && !v6.length) {
    if (found.error?.error === 'AGAIN') { err(`;; ${found.error.message}`); err(';; no servers could be reached'); return 1 }
    out(`Host ${name} not found: 3(NXDOMAIN)\n`)
    return 1
  }
  for (const address of v4) out(`${name} has address ${address}\n`)
  for (const address of v6) out(`${name} has IPv6 address ${address}\n`)
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`host: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
