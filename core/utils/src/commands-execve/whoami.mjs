/** Print the effective username, read from `env.USER`. */

const { argv, exit, writeAll, env } = globalThis.ecmaosSyscalls

const usage = `Usage: whoami
Print effective user ID.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  writeAll(1, new TextEncoder().encode((env.USER || 'root') + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`whoami: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
