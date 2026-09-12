/**
 * Real `execve`'d `hostname` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/hostname.ts`) per `feat/1.0.0-execve-commands`. The original read
 * `window.location.hostname` (undefined in a Worker regardless -- it already fell back to a fixed
 * `'localhost'` string in any non-window context, this migration included). `env.HOSTNAME` now
 * carries that same value, threaded through `Shell`'s env at construction (see `kernel.ts`).
 */

const { argv, exit, write, env } = globalThis.ecmaosSyscalls

const usage = `Usage: hostname [OPTION]
Print the system hostname.

  -f, --fqdn              print the FQDN (Fully Qualified Domain Name)
  -s, --short             print the short hostname
  --help                  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let showFqdn = false
  let showShort = false
  const positional = []

  for (const arg of args) {
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      write(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-f' || arg === '--fqdn') {
      showFqdn = true
    } else if (arg === '-s' || arg === '--short') {
      showShort = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('f')) showFqdn = true
      if (flags.includes('s')) showShort = true
      const invalid = flags.find(f => !['f', 's'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`hostname: invalid option -- '${invalid}'\nTry 'hostname --help' for more information.\n`))
        return 1
      }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 0) {
    write(2, new TextEncoder().encode("hostname: invalid argument\nTry 'hostname --help' for more information.\n"))
    return 1
  }

  const hostname = env.HOSTNAME || 'localhost'
  let output

  if (showFqdn) {
    output = hostname
  } else if (showShort) {
    output = hostname.split('.')[0] ?? hostname
  } else {
    output = hostname
  }

  write(1, new TextEncoder().encode(output + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`hostname: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
