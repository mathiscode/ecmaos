/**
 * Real `execve`'d `tty` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/tty.ts`) per this session's M1 pass. `kernel.activeTty`/
 * `kernel.switchTty()` are live `Kernel` state a worker can't see directly, reached through the
 * `tty_get`/`tty_switch` custom syscalls (`#lib/main-thread-syscalls.ts`), the same `custom`/
 * `syscall_async` bridge `reboot.mjs`/`df.mjs` use. Unlike `df`/`ps`, `kernel.activeTty` is already
 * a plain number, so this needs no scratch-file round trip at all -- the syscall's own numeric
 * return is the answer.
 */

const { argv, exit, write, custom } = globalThis.ecmaosSyscalls

const usage = `Usage: tty [TTY_NUMBER]
Print the current TTY number or switch to a different TTY.

  TTY_NUMBER    switch to the specified TTY (0-7)
  --help        display this help and exit

If no TTY_NUMBER is provided, prints the current TTY number.
If TTY_NUMBER is provided, switches to that TTY.`

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    const activeTty = await custom('tty_get')
    write(1, new TextEncoder().encode(activeTty.toString() + '\n'))
    return 0
  }

  if (args.length > 1) {
    write(2, new TextEncoder().encode('tty: too many arguments\n'))
    write(2, new TextEncoder().encode("Try 'tty --help' for more information.\n"))
    return 1
  }

  const ttyNumber = parseInt(args[0] ?? '0', 10)

  if (Number.isNaN(ttyNumber)) {
    write(2, new TextEncoder().encode(`tty: invalid TTY number '${args[0]}'\n`))
    write(2, new TextEncoder().encode("Try 'tty --help' for more information.\n"))
    return 1
  }

  if (ttyNumber < 0 || ttyNumber > 7) {
    write(2, new TextEncoder().encode('tty: TTY number must be between 0 and 7\n'))
    write(2, new TextEncoder().encode("Try 'tty --help' for more information.\n"))
    return 1
  }

  try {
    await custom('tty_switch', ttyNumber)
    return 0
  } catch (error) {
    write(2, new TextEncoder().encode(`tty: failed to switch to TTY ${ttyNumber}: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`tty: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
