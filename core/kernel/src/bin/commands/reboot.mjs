/** Shut down every kernel subsystem and reload the page. */

const { exit, write, custom } = globalThis.ecmaosSyscalls

try {
  await custom('reboot')
  exit(0)
} catch (error) {
  write(2, new TextEncoder().encode(`reboot: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
