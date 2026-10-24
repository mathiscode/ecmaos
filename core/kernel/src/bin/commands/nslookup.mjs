/** Look up the addresses of a name: `nslookup example.com`. */

import { isIPv4, isIPv6, lookupBoth } from './lib/lookup.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: nslookup NAME
Look up the addresses of NAME.

  --help  display this help and exit

The name is looked up in /etc/hosts, then by the gateway's resolver (gateway up). Only A and AAAA answers
exist, and there is no interactive mode or reverse lookup.`

async function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) { out(usage + '\n'); return 0 }
  const name = args.find(arg => !arg.startsWith('-'))
  if (!name) { err(usage.split('\n')[0]); return 1 }
  if (isIPv4(name) || isIPv6(name)) { err('nslookup: reverse lookups are not available'); return 1 }

  const found = await lookupBoth(name)
  out('Server:\t\tthe gateway\nAddress:\t-\n\n')
  if (!found.v4.length && !found.v6.length) {
    if (found.error?.error === 'AGAIN') { err(`;; ${found.error.message}`); err(';; no servers could be reached'); return 1 }
    out(`** server can't find ${name}: NXDOMAIN\n`)
    return 1
  }
  out('Non-authoritative answer:\n')
  for (const address of [...found.v4, ...found.v6]) out(`Name:\t${name}\nAddress: ${address}\n`)
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`nslookup: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
