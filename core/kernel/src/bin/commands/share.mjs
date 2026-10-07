/**
 * Offer a directory of this machine to another ecmaOS machine (`ecmaos --listen`), which mounts it as /mnt/NAME. Like `connect`,
 * it logs in with your key; the link stays up in the background until `share -d NAME` or until either side ends it.
 */
import { echoOff, isTty } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'
import { getopt } from './lib/getopt.mjs'

const { argv, exit, write, read, custom, open, close, unlink, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const say = (fd, text) => write(fd, encoder.encode(text + '\n'))

const usage = `Usage: share [OPTIONS] [USER@]HOST[:PORT] PATH [NAME]
       share -l
       share -d NAME

Offer PATH to the machine HOST, which mounts it as /mnt/NAME (NAME defaults to the last part of PATH). Only root can share, and
the machine only accepts it from root. The directory is copied into the other machine's memory when it is mounted, so a
large one is refused there.

Options:
  -r, --read-only         the other machine may read it but not change it
  -p, --pair CODE         enrol your key with this one-time pairing code first
  -F, --fingerprint FP    accept the host only if its key has this fingerprint (SHA256:...)
  -y, --accept-new        remember a host seen for the first time
  -l, --list              list what is shared
  -d, --delete NAME       stop sharing NAME
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
  const path = scratchPath('share')
  await custom('peer_share', JSON.stringify(request), path)
  const outcome = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  for (const { stream, text } of outcome.lines) say(stream === 'err' ? 2 : 1, text)
  return outcome.code
}

async function main() {
  const parsed = getopt(argv.slice(1), { flags: 'rlyh', values: 'pFd', long: { 'read-only': 'r', pair: 'p', fingerprint: 'F', 'accept-new': 'y', list: 'l', delete: 'd' } })
  if (parsed.error) { say(2, `share: ${parsed.error}`); return 1 }
  const { opts, rest } = parsed
  if (opts.help) { say(2, usage); return 0 }
  if (opts.l) return await ask({ action: 'list' })
  if (opts.d) return await ask({ action: 'stop', name: opts.d })
  if (rest.length < 2 || rest.length > 3) { say(2, usage); return 1 }

  const [target, path, given] = rest
  const name = given ?? (path.replace(/\/+$/, '').split('/').pop() || 'root')
  const options = {}
  if (opts.p) options.pair = opts.p
  if (opts.F) options.fingerprint = opts.F
  if (opts.y) options['accept-new'] = 'yes'
  options.password = readSecret('Password (unlocks your key): ')
  return await ask({ action: 'start', target, path, name, readOnly: !!opts.r, cwd: getcwd(), options })
}

try {
  exit(await main())
} catch (error) {
  say(2, `share: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
