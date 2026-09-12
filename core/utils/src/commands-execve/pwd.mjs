/**
 * Real `execve`'d `pwd` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/pwd.ts`) per `feat/1.0.0-execve-commands`. `shell.cwd` is replaced by the
 * real `getcwd()` syscall -- always reflects a real `chdir()` mid-process, unlike `init.cwd` which is
 * only the cwd at the moment this program was launched (see `node.mjs`'s doc comment on `argv`/`env`).
 */

const { argv, exit, write, getcwd } = globalThis.ecmaosSyscalls

const usage = `Usage: pwd
Print the name of the current working directory.

  --help  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  write(1, new TextEncoder().encode(getcwd() + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`pwd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
