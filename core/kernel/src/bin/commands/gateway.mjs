/**
 * The machine's route to the real network: `gateway up HOST` logs in to another ecmaOS machine started with
 * `ecmaos --listen --gateway` (as `connect` does) and keeps the link; from then on a program's `connect()` to an address that
 * is not this machine goes through it. `gateway down` closes the link, `gateway` shows it.
 */
import { echoOff, isTty } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'
import { getopt } from './lib/getopt.mjs'

const { argv, exit, write, read, custom, open, close, unlink } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const say = (fd, text) => write(fd, encoder.encode(text + '\n'))

const usage = `Usage: gateway up [OPTIONS] [USER@]HOST[:PORT]
       gateway down
       gateway [status]

Send this machine's outbound connections through HOST, an ecmaOS machine started with 'ecmaos --listen --gateway'. It logs in
with your key like 'connect' and asks for your password to unlock it. Only root can bring the gateway up or down. The machine
decides what it will reach; it never reaches its own network unless its operator said so.

Options (gateway up):
  -p, --pair CODE         enrol your key with this one-time pairing code first
  -F, --fingerprint FP    accept the host only if its key has this fingerprint (SHA256:...)
  -y, --accept-new        remember a host seen for the first time
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
  const path = scratchPath('gateway')
  await custom('gateway_ctl', JSON.stringify(request), path)
  const outcome = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  for (const { stream, text } of outcome.lines) say(stream === 'err' ? 2 : 1, text)
  return outcome.code
}

async function main() {
  const parsed = getopt(argv.slice(1), { flags: 'yh', values: 'pF', long: { pair: 'p', fingerprint: 'F', 'accept-new': 'y' } })
  if (parsed.error) { say(2, `gateway: ${parsed.error}`); return 1 }
  const { opts, rest } = parsed
  if (opts.help) { say(2, usage); return 0 }
  const action = rest[0] ?? 'status'
  if (action === 'status' && rest.length <= 1) return await ask({ action: 'status' })
  if (action === 'down' && rest.length === 1) return await ask({ action: 'down' })
  if (action === 'up' && rest.length === 2) {
    const options = {}
    if (opts.p) options.pair = opts.p
    if (opts.F) options.fingerprint = opts.F
    if (opts.y) options['accept-new'] = 'yes'
    options.password = readSecret('Password (unlocks your key): ')
    return await ask({ action: 'up', target: rest[1], options })
  }
  say(2, usage)
  return 1
}

try {
  exit(await main())
} catch (error) {
  say(2, `gateway: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
