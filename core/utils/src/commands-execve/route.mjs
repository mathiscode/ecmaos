/** `route`: show the kernel routing table. It is empty here: the loopback's own routes are in the local table, which `route` does not list. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`route: ${text}\n`))

const usage = `Usage: route [-nee] [-v] [-A family]
       route add|del ...

Shows the routing table. This machine has no routes to list: a program reaches the network through the gateway
(gateway up), which is not a route. Nothing can be changed with route.`

function main() {
  const args = argv.slice(1)
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === 'add' || arg === 'del' || arg === 'delete' || arg === 'flush') { err('SIOCADDRT: Operation not permitted'); return 1 }
  }
  const family = args.indexOf('-A')
  if (family !== -1 && args[family + 1] === 'inet6') {
    out('Kernel IPv6 routing table\nDestination                    Next Hop                   Flag Met Ref Use If\n')
    return 0
  }
  out('Kernel IP routing table\nDestination     Gateway         Genmask         Flags Metric Ref    Use Iface\n')
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
