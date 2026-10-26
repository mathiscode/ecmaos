/** Allow or refuse messages from `write` and `wall` on this terminal, by the write bits of its device. */

import { getopt } from './lib/getopt.mjs'
import { acceptsMessages, MESSAGE_BITS } from './lib/mesg-state.mjs'

const { argv, exit, writeAll, tcgetattr, chmod, stat, custom } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`mesg: ${text}\n`))

const usage = `Usage: mesg [y|n]
Display or set the message permission of the terminal.

  y   allow write and wall to write to this terminal
  n   refuse them (root can still write)

With no argument it prints is y or is n. The exit status is 0 for y, 1 for n and 2 for an error.`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'v', long: { help: 'help', version: 'version', verbose: 'v' } })
  if (error) { err(error); return 2 }
  for (const [key] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('mesg (ecmaOS coreutils) 1.0\n'); return 0 }
  }
  if (operands.length > 1) { err('too many arguments'); return 2 }
  try { tcgetattr(0) } catch { err('ttyname failed: Inappropriate ioctl for device'); return 2 }
  const number = await custom('tty_get')
  const device = number >= 1000 ? `/dev/pts/${number - 1000}` : `/dev/xterm${number}`

  const want = operands[0]
  if (want !== undefined) {
    if (want !== 'y' && want !== 'n') { err(`invalid argument ‘${want}’`); return 2 }
    try {
      const mode = stat(device).mode & 0o7777
      chmod(device, want === 'y' ? mode | MESSAGE_BITS : mode & ~MESSAGE_BITS)
    } catch (e) { err(`${device}: ${e?.message ?? e}`); return 2 }
    return want === 'y' ? 0 : 1
  }
  const yes = acceptsMessages(device)
  out(`is ${yes ? 'y' : 'n'}\n`)
  return yes ? 0 : 1
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(2)
}
