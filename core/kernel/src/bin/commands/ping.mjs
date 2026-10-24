/** Time a connection to a host: `ping -c 3 example.com`. A browser cannot send ICMP, so this connects with TCP. */

import { getopt } from './lib/getopt.mjs'
import { isIPv4, isIPv6, lookup, probe } from './lib/lookup.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const usage = `Usage: ping [-c COUNT] [-i SECONDS] [-p PORT] HOST
Time a TCP connection to HOST.

  -c COUNT    stop after COUNT connections (default 4)
  -i SECONDS  wait SECONDS between connections (default 1)
  -p PORT     the port to connect to (default 443)
  --help      display this help and exit

A browser cannot send an ICMP echo, so ping connects to a TCP port through the gateway (gateway up) and times how long
the connection takes to open. A host that does not listen on the port is not reachable by this, though it may be up.`

async function main() {
  const parsed = getopt(argv.slice(1), { values: 'cip', long: { count: 'c', interval: 'i', port: 'p' } })
  if (parsed.error) { err(`ping: ${parsed.error}`); return 2 }
  if (parsed.opts.help) { out(usage + '\n'); return 0 }
  const [host] = parsed.rest
  if (!host) { err(usage.split('\n')[0]); return 2 }
  const count = parsed.opts.c === undefined ? 4 : Number(parsed.opts.c)
  const interval = parsed.opts.i === undefined ? 1 : Number(parsed.opts.i)
  const port = parsed.opts.p === undefined ? 443 : Number(parsed.opts.p)
  if (!(count >= 1) || !(interval >= 0) || !(port >= 1 && port <= 65535)) { err('ping: bad count, interval or port'); return 2 }

  let address = host
  if (!isIPv4(host) && !isIPv6(host)) {
    const answer = await lookup(host, 4)
    if (!answer.addresses?.length) { err(`ping: ${host}: ${answer.error === 'AGAIN' ? answer.message : 'Name or service not known'}`); return 2 }
    address = answer.addresses[0]
  }
  if (address.startsWith('127.') || address === '::1') {
    out(`PING ${host} (${address}): that is this machine; there is no network between to time\n`)
    return 0
  }

  out(`PING ${host} (${address}): timing a TCP connection to port ${port}; a browser cannot send ICMP\n`)
  const times = []
  for (let seq = 1; seq <= count; seq++) {
    const started = performance.now()
    const result = await probe(address, port)
    const ms = performance.now() - started
    if (result.ok) {
      times.push(ms)
      out(`connected to ${address}:${port} seq=${seq} time=${ms.toFixed(1)} ms\n`)
    } else {
      out(`${address}:${port} seq=${seq} ${result.message}\n`)
    }
    if (seq < count) await sleep(interval * 1000)
  }
  out(`\n--- ${host} ping statistics ---\n${count} connections tried, ${times.length} opened, ${Math.round(100 - 100 * times.length / count)}% failed\n`)
  if (times.length) {
    const average = times.reduce((sum, ms) => sum + ms, 0) / times.length
    out(`min/avg/max = ${Math.min(...times).toFixed(1)}/${average.toFixed(1)}/${Math.max(...times).toFixed(1)} ms\n`)
  }
  return times.length ? 0 : 1
}

try {
  exit(await main())
} catch (error) {
  err(`ping: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
