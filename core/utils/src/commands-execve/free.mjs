/** Display memory usage, reading `/proc/meminfo`. */

const { argv, exit, writeAll, read, open, close, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: free [-h|-k|-m]
Display the amount of memory the browser reports available.

  -h  human-readable output (auto-scaled units)
  -k  show output in kibibytes (the default)
  -m  show output in mebibytes
  --help  display this help and exit`

function readMeminfo() {
  const fd = open('/proc/meminfo', O_RDONLY)
  try {
    const chunkSize = 65536
    const chunks = []
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0)
    const combined = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { combined.set(c, offset); offset += c.length }
    return new TextDecoder().decode(combined)
  } finally {
    close(fd)
  }
}

/** Parses `/proc/meminfo`'s `Key:  N kB` lines into kibibytes, keyed by name. */
function parseMeminfo(text) {
  const values = {}
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s*(\d+)\s*kB\s*$/.exec(line)
    if (match) values[match[1]] = Number(match[2])
  }
  return values
}

function humanize(kb) {
  const units = ['K', 'M', 'G', 'T']
  let value = kb
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)}${units[unitIndex]}`
}

/** Right-aligns `text` in a field of `width` columns, matching `free`'s own column layout. */
function column(text, width) {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function main() {
  const args = argv.slice(1)
  if (args.includes('--help')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const human = args.includes('-h')
  const mebi = args.includes('-m')
  // -k is the default; only -m and -h change the unit, matching real `free`'s precedence
  // (the last one wins in practice, but this command's scope never combines them meaningfully).
  const divisor = mebi ? 1024 : 1

  let meminfo
  try {
    meminfo = parseMeminfo(readMeminfo())
  } catch {
    writeAll(2, new TextEncoder().encode('free: /proc/meminfo is not available in this environment\n'))
    return 1
  }

  const totalKb = meminfo.MemTotal ?? 0
  const freeKb = meminfo.MemFree ?? 0
  const availableKb = meminfo.MemAvailable ?? freeKb
  const usedKb = Math.max(0, totalKb - freeKb)

  const format = (kb) => human ? humanize(kb) : String(Math.round(kb / divisor))
  const unitLabel = human ? '' : (mebi ? 'Mi' : 'Ki')

  const header = `${column('total', 16)}${column('used', 12)}${column('free', 12)}${column('available', 12)}`
  const row = `${'Mem:'.padEnd(7)}${column(format(totalKb), 9)}${column(format(usedKb), 12)}${column(format(freeKb), 12)}${column(format(availableKb), 12)}`

  writeAll(1, new TextEncoder().encode((unitLabel ? `(${unitLabel}B units)\n` : '') + header + '\n' + row + '\n'))
  return 0
}

exit(main())
