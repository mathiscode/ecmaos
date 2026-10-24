/** Show the machine's network interfaces and routes: `ip addr`, `ip link`, `ip route`. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: ip [-4] [-6] [-br] OBJECT [show]
where OBJECT is one of: addr (a), link (l), route (r), neigh (n)

This machine has one interface, the loopback lo. A program reaches the network through the gateway
(gateway up), which is not an interface: it carries each connection a program opens, so there is no
address or route to show for it. Nothing can be changed with ip.`

const LINK = '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n'
const INET = '    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n'
const INET6 = '    inet6 ::1/128 scope host noprefixroute\n       valid_lft forever preferred_lft forever\n'

function main() {
  const args = argv.slice(1)
  const flags = new Set()
  while (args[0]?.startsWith('-')) {
    const flag = args.shift()
    if (flag === '-h' || flag === '--help' || flag === '-help') { out(usage + '\n'); return 0 }
    flags.add(flag.replace(/^--?/, ''))
  }
  const object = args.shift()
  if (object === undefined || object === 'help') { out(usage + '\n'); return object === undefined ? 1 : 0 }
  const brief = flags.has('br') || flags.has('brief') || flags.has('b')
  const only4 = flags.has('4') || flags.has('family=inet')
  const only6 = flags.has('6') || flags.has('family=inet6')
  const action = args[0]
  if (action !== undefined && !['show', 'list', 'lst', 'sh', 'ls', 'dev'].includes(action)) {
    err(`ip: ${object}: "${action}" changes the network, and nothing can be changed here`)
    return 2
  }
  const device = args[0] === 'dev' ? args[1] : args[0] === 'show' && args[1] === 'dev' ? args[2] : undefined
  if (device !== undefined && device !== 'lo') { err(`Device "${device}" does not exist.`); return 1 }

  if (['addr', 'address', 'a', 'ad'].includes(object)) {
    if (brief) out(`lo               UNKNOWN        ${[only6 ? '' : '127.0.0.1/8', only4 ? '' : '::1/128'].filter(Boolean).join(' ')}\n`)
    else out(LINK + (only6 ? '' : INET) + (only4 ? '' : INET6))
  } else if (['link', 'l', 'li'].includes(object)) {
    out(brief ? 'lo               UNKNOWN        00:00:00:00:00:00 <LOOPBACK,UP,LOWER_UP>\n' : LINK)
  } else if (['route', 'r', 'ro', 'rout'].includes(object) || ['neigh', 'neighbor', 'n', 'neighbour'].includes(object)) {
    // no routes and no neighbours: the loopback's own are in the local table, which this does not list
  } else {
    err(`Object "${object}" is unknown, try "ip help".`)
    return 1
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`ip: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
