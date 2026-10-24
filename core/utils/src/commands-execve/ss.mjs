/** Show sockets, read from `/proc/net`: `ss -ltn` lists what is listening. */

import { getopt } from './lib/getopt.mjs'
import { inetSockets, unixSockets } from './lib/procnet.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: ss [OPTIONS]
Show sockets.

  -a, --all        all sockets, listening or not
  -l, --listening  only listening sockets (the default shows the others)
  -t, --tcp        TCP sockets
  -u, --udp        UDP sockets
  -x, --unix       Unix sockets
  -4, --ipv4       IPv4 sockets
  -6, --ipv6       IPv6 sockets
  -n, --numeric    do not resolve names (addresses and ports are always numbers here)
  -H, --no-header  no header line
  -p, --processes  accepted; the program is not shown, since a socket is not a descriptor in /proc
  -h, --help       display this help and exit

Reads /proc/net/tcp, tcp6, udp, udp6 and unix: the TCP sockets listening on this machine, the UDP ports programs
have bound, and Unix sockets that have a name. A connection between two programs is a pair of pipes and has no row.`

function endpoint(address, port, six) {
  const shown = six || address.includes(':') ? `[${address}]` : address
  return `${shown}:${port === 0 ? '*' : port}`
}

function main() {
  const parsed = getopt(argv.slice(1), {
    short: 'altux46nHph',
    long: { all: 'a', listening: 'l', tcp: 't', udp: 'u', unix: 'x', ipv4: '4', ipv6: '6', numeric: 'n', 'no-header': 'H', processes: 'p', help: 'h' }
  })
  if (parsed.error) { err(`ss: ${parsed.error}`); err("Try 'ss --help' for more information."); return 1 }
  const flags = new Set(parsed.options.map(([key]) => key))
  if (flags.has('h')) { out(usage + '\n'); return 0 }
  if (parsed.operands.length) { err('ss: filter expressions are not supported'); return 1 }

  const chosen = ['t', 'u', 'x'].filter(flag => flags.has(flag))
  const wants = kind => chosen.length === 0 || chosen.includes(kind)
  const wantsFamily = six => (!flags.has('4') && !flags.has('6')) || (six ? flags.has('6') : flags.has('4'))
  const listeningOnly = flags.has('l') && !flags.has('a')
  const keep = socket => flags.has('a') ? true : listeningOnly ? socket.state === 'LISTEN' || (socket.netid === 'udp' && socket.state === 'UNCONN') : socket.state !== 'LISTEN' && socket.state !== 'UNCONN'

  const rows = []
  for (const socket of inetSockets()) {
    if (!wants(socket.netid === 'tcp' ? 't' : 'u') || !wantsFamily(socket.six) || !keep(socket)) continue
    rows.push([socket.netid, socket.state, '0', socket.state === 'LISTEN' ? '4096' : '0', endpoint(socket.local, socket.localPort, socket.six), endpoint(socket.peer, socket.peerPort, socket.six), ''])
  }
  if (wants('x') && !flags.has('4') && !flags.has('6')) {
    for (const socket of unixSockets()) {
      if (!keep(socket)) continue
      rows.push([socket.netid, socket.state, '0', socket.state === 'LISTEN' ? '4096' : '0', `${socket.path} ${socket.inode}`, '* 0', ''])
    }
  }

  const header = ['Netid', 'State', 'Recv-Q', 'Send-Q', 'Local Address:Port', 'Peer Address:Port', 'Process']
  const table = flags.has('H') ? rows : [header, ...rows]
  const widths = header.map((_, column) => Math.max(...table.map(row => row[column].length)))
  // the Netid column is shown when more than one kind of socket can be in the listing
  const showNetid = chosen.length !== 1
  const lines = table.map(row => row.map((cell, column) => cell.padEnd(widths[column])).filter((_, column) => showNetid || column > 0).join(' ').trimEnd())
  if (lines.length) out(lines.join('\n') + '\n')
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`ss: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
