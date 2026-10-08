/**
 * Use a device of another ecmaOS machine (`ecmaos --listen --device ...`) as /dev/NAME here. Like `connect` it logs in with
 * your key; the link stays up in the background until `attach -d NAME` or until either side ends it (unplugging the device
 * there removes /dev/NAME here).
 */
import { echoOff, isTty } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'
import { getopt } from './lib/getopt.mjs'

const { argv, exit, write, read, custom, open, close, unlink } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const say = (fd, text) => write(fd, encoder.encode(text + '\n'))

const usage = `Usage: attach [OPTIONS] [USER@]HOST[:PORT]/DEVICE [NAME]
       attach -l
       attach -d NAME
       attach -c NAME OPERATION [JSON-ARGUMENT...]
       attach -s [USER@]HOST[:PORT] NAME DEVICE

Make the device DEVICE of the machine HOST appear here as /dev/NAME (NAME defaults to DEVICE). Only root can attach, and the
machine only hands devices to root. The machine decides which devices it offers and whether they can be written to.

Options:
  -p, --pair CODE         enrol your key with this one-time pairing code first
  -F, --fingerprint FP    accept the host only if its key has this fingerprint (SHA256:...)
  -y, --accept-new        remember a host seen for the first time
  -l, --list              list the attached devices
  -d, --detach NAME       remove /dev/NAME and close the link
  -c, --control NAME      send an operation to the device (what it knows depends on the device); the rest are its arguments as JSON
  -s, --serve             the other way round: offer DEVICE of this machine to HOST, where it appears as /dev/NAME. DEVICE is
                          loopback, serial:N[,baud=RATE] (the Nth serial port this browser has been given, see 'serial
                          request'), midi:in=N[,out=M] or midi:out=N, gamepad:N, hid:N, usb:N[,in=EP,out=EP], bluetooth:N[,...],
                          battery, geo, sensor:KIND, audio:in, audio:out or camera[:N] (see the manual page). The machine
                          only takes it from root. -d NAME stops offering it.
  --help                  display this help and exit`

function readSecret(prompt) {
  write(2, encoder.encode(prompt))
  const restore = echoOff(0)
  const bytes = []
  try {
    const buffer = new Uint8Array(256)
    while (true) {
      const n = read(0, buffer, -1)
      if (n <= 0) break
      bytes.push(...buffer.subarray(0, n))
      if (buffer[n - 1] === 10) break
    }
  } finally {
    restore()
  }
  if (isTty(0)) write(2, encoder.encode('\n'))
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/[\r\n]+$/, '')
}

async function ask(request) {
  const path = scratchPath('attach')
  await custom('peer_attach', JSON.stringify(request), path)
  const outcome = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  for (const { stream, text } of outcome.lines) say(stream === 'err' ? 2 : 1, text)
  return outcome.code
}

async function main() {
  const parsed = getopt(argv.slice(1), { flags: 'lysh', values: 'pFdc', long: { pair: 'p', fingerprint: 'F', 'accept-new': 'y', list: 'l', detach: 'd', control: 'c', serve: 's' } })
  if (parsed.error) { say(2, `attach: ${parsed.error}`); return 1 }
  const { opts, rest } = parsed
  if (opts.help) { say(2, usage); return 0 }
  if (opts.l) return await ask({ action: 'list' })
  if (opts.d) return await ask({ action: 'detach', name: opts.d })
  if (opts.c) {
    if (rest.length < 1) { say(2, usage); return 1 }
    let args
    try { args = rest.slice(1).map(text => JSON.parse(text)) } catch { say(2, 'attach: the arguments must be JSON (a string needs quotes)'); return 1 }
    return await ask({ action: 'control', name: opts.c, op: rest[0], args })
  }
  if (opts.s) {
    if (rest.length !== 3) { say(2, usage); return 1 }
    const served = {}
    if (opts.p) served.pair = opts.p
    if (opts.F) served.fingerprint = opts.F
    if (opts.y) served['accept-new'] = 'yes'
    served.password = readSecret('Password (unlocks your key): ')
    return await ask({ action: 'serve', target: rest[0], name: rest[1], spec: rest[2], options: served })
  }
  if (rest.length < 1 || rest.length > 2) { say(2, usage); return 1 }

  const options = {}
  if (opts.p) options.pair = opts.p
  if (opts.F) options.fingerprint = opts.F
  if (opts.y) options['accept-new'] = 'yes'
  options.password = readSecret('Password (unlocks your key): ')
  return await ask({ action: 'attach', target: rest[0], name: rest[1], options })
}

try {
  exit(await main())
} catch (error) {
  say(2, `attach: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
