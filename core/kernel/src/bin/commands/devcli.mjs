/**
 * `/bin/devcli <device> [args...]`: the real process behind a device's command line (`/dev/battery
 * status`). The device's `cli` runs main-thread side (`#lib/device-cli.ts`) because the hardware APIs
 * it drives only exist there; its output arrives here through a pipe fd and is copied to stdout, so
 * pipes and redirects work, and this process's exit code is the `cli`'s return value.
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const { argv, exit, write, writeAll, read, close, open, unlink, custom } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()

const name = argv[1]
if (!name) {
  write(2, encoder.encode('usage: devcli <device> [args...]\n'))
  exit(2)
}

try {
  const path = scratchPath('devcli')
  await custom('device_cli_start', name, JSON.stringify(argv.slice(2)), path)
  const started = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  if (started.error) {
    write(2, encoder.encode(`${started.error}\n`))
    exit(1)
  }

  while (true) {
    const buffer = new Uint8Array(65536)
    const n = read(started.fd, buffer, -1)
    if (n <= 0) break
    writeAll(1, buffer.subarray(0, n))
  }

  exit(await custom('device_cli_wait'))
} catch (error) {
  write(2, encoder.encode(`${name}: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
