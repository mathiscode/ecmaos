/** `arp`: show the ARP cache. It is always empty here: no interface speaks ARP, the loopback has no neighbours. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`arp: ${text}\n`))

const usage = `Usage: arp [-vn] [-H type] [-i if] [-a] [hostname]
       arp -s|-d ...

Shows the ARP cache, which is empty: no interface here speaks ARP. Nothing can be changed with arp.`

function main() {
  const args = argv.slice(1)
  for (const arg of args) {
    if (arg === '-h' || arg === '--help' || arg === '-?') { out(usage + '\n'); return 0 }
    if (arg === '-s' || arg === '-d' || arg === '--set' || arg === '--delete') { err('SIOCSARP: Operation not permitted'); return 1 }
  }
  const skip = new Set()
  args.forEach((arg, index) => { if (arg === '-i' || arg === '-H' || arg === '-A') skip.add(index + 1) })
  const host = args.find((arg, index) => !arg.startsWith('-') && !skip.has(index))
  if (host !== undefined) { out(`${host} (${host}) -- no entry\n`); return 255 }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
