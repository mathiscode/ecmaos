/** Look up the addresses of a name: `dig example.com`, `dig +short example.com AAAA`. */

import { isIPv4, isIPv6, lookup } from './lib/lookup.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: dig [+short] NAME [A | AAAA]
Look up the addresses of NAME.

  +short  print only the addresses
  --help  display this help and exit

The name is looked up in /etc/hosts, then by the gateway's resolver (gateway up). Only A and AAAA records exist,
and the time to live is 0: the resolver does not pass it on.`

async function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) { out(usage + '\n'); return 0 }
  const short = args.includes('+short')
  const words = args.filter(arg => !arg.startsWith('+') && !arg.startsWith('-') && !arg.startsWith('@'))
  const record = /^(A|AAAA|MX|NS|TXT|CNAME|SOA|ANY|PTR)$/i
  const type = words.find(word => record.test(word))?.toUpperCase() ?? 'A'
  const name = words.find(word => !record.test(word)) ?? words[0]
  if (!name) { err(usage.split('\n')[0]); return 1 }
  if (type !== 'A' && type !== 'AAAA') { err(`dig: ${type} records are not available; only A and AAAA`); return 1 }
  if (isIPv4(name) || isIPv6(name)) { err('dig: reverse lookups are not available'); return 1 }

  const started = performance.now()
  const answer = await lookup(name, type === 'AAAA' ? 6 : 4)
  const msec = Math.round(performance.now() - started)
  if (answer.error === 'AGAIN') { err(`;; ${answer.message}`); err(';; no servers could be reached'); return 9 }
  const addresses = answer.addresses ?? []
  if (short) {
    for (const address of addresses) out(address + '\n')
    return 0
  }
  const status = addresses.length ? 'NOERROR' : 'NXDOMAIN'
  out(`\n; <<>> ecmaOS dig <<>> ${name} ${type}\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${status}\n\n;; QUESTION SECTION:\n;${name}.\t\t\tIN\t${type}\n\n`)
  if (addresses.length) {
    out(';; ANSWER SECTION:\n')
    for (const address of addresses) out(`${name}.\t\t0\tIN\t${type}\t${address}\n`)
    out('\n')
  }
  out(`;; Query time: ${msec} msec\n;; SERVER: the gateway\n;; WHEN: ${new Date().toString()}\n\n`)
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`dig: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
