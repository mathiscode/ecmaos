/**
 * Real `execve`'d `whoami` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/whoami.ts`) per `feat/1.0.0-execve-commands`. `shell.username` is
 * replaced by `env.USER` (already part of every shell's env, per `Shell`'s `DefaultShellOptions`).
 */

const { argv, exit, write, env } = globalThis.ecmaosSyscalls

const usage = `Usage: whoami
Print effective user ID.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  write(1, new TextEncoder().encode((env.USER || 'root') + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`whoami: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
