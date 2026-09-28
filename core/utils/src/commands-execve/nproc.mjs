/** Print the number of available processing units. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const usage = `Usage: nproc
Print the number of processing units available.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const cores = navigator.hardwareConcurrency || 1
  writeAll(1, new TextEncoder().encode(String(cores) + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`nproc: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
