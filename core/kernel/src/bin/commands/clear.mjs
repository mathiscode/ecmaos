/** Clear the terminal screen. */

const { exit, write } = globalThis.ecmaosSyscalls

try {
  write(1, new TextEncoder().encode('\x1b[2J\x1b[H'))
  exit(0)
} catch (error) {
  write(2, new TextEncoder().encode(`clear: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
