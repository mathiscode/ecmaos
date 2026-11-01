/** `ifconfig`: show the network interfaces. This machine has one, the loopback; the gateway carries a program's connections and is not an interface. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`ifconfig: ${text}\n`))

const usage = `Usage:
  ifconfig [-a] [-v] [-s] [interface]

Shows the loopback, lo, the only interface this machine has. A program reaches the network through the gateway
(gateway up), which is not an interface, so there is no address to show for it. Nothing can be changed with ifconfig.`

const LO = `lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
        inet6 ::1  prefixlen 128  scopeid 0x10<host>
        loop  txqueuelen 1000  (Local Loopback)
        RX packets 0  bytes 0 (0.0 B)
        RX errors 0  dropped 0  overruns 0  frame 0
        TX packets 0  bytes 0 (0.0 B)
        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0

`

const SHORT = `Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg
lo       65536        0      0      0 0             0      0      0      0 LRU
`

function main() {
  const args = argv.slice(1)
  let short = false
  const names = []
  const rest = []
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '-a' || arg === '-v') continue
    if (arg === '-s') { short = true; continue }
    if (arg.startsWith('-')) { err(`invalid option -- '${arg.replace(/^-+/, '')}'`); out(usage + '\n'); return 1 }
    if (names.length === 0) names.push(arg)
    else rest.push(arg)
  }
  if (rest.length) { err('SIOCSIFFLAGS: Operation not permitted'); return 255 }
  if (names.length && names[0] !== 'lo') { err(`${names[0]}: error fetching interface information: Device not found`); return 255 }
  out(short ? SHORT : LO)
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
