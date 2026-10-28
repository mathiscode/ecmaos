/** What a command says when the machine cannot do what it is for: one line, and a failing status, as a facade would not. */

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

/** Never returns: prints `NAME: REASON` on stderr and exits 1 (`--help` and `--version` still answer) */
export function unsupported(name, reason) {
  const encoder = new TextEncoder()
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    writeAll(1, encoder.encode(`Usage: ${name} [OPTION]... COMMAND\n\nThis machine cannot do this: ${reason}\n`))
    exit(0)
  }
  if (args.includes('--version') || args.includes('-V')) { writeAll(1, encoder.encode(`${name} (ecmaOS coreutils) 1.0\n`)); exit(0) }
  writeAll(2, encoder.encode(`${name}: ${reason}\n`))
  exit(1)
}
