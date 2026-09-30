/**
 * Change a login shell. `chsh -s SHELL [USER]` changes it (yours, or anyone's as root); `chsh -l`
 * lists the shells in `/etc/shells`. The new shell applies from the next login.
 */
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const { argv, exit, write, custom, open, read, close, unlink } = globalThis.ecmaosSyscalls

const usage = `Usage: chsh -s SHELL [USER]
       chsh -l
Change the login shell. SHELL must be listed in /etc/shells.

  -s, --shell SHELL  the new login shell
  -l, --list-shells  print the shells in /etc/shells
  --help             display this help and exit`

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const stderr = text => write(2, encoder.encode(text + '\n'))

function readFile(path) {
  const fd = open(path, 0, 0)
  try {
    const chunks = []
    const buffer = new Uint8Array(4096)
    for (;;) {
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
    }
    return chunks.join('')
  } finally {
    close(fd)
  }
}

async function main() {
  const args = argv.slice(1)
  let shellValue
  let username = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { stderr(usage); return 0 }
    if (arg === '-l' || arg === '--list-shells') {
      for (const line of readFile('/etc/shells').split('\n')) if (line.trim() && !line.startsWith('#')) write(1, encoder.encode(line.trim() + '\n'))
      return 0
    }
    if (arg === '-s' || arg === '--shell') shellValue = args[++i]
    else if (!arg.startsWith('-')) username = arg
    else { stderr(`chsh: invalid option -- '${arg}'`); return 1 }
  }
  if (!shellValue) { stderr(usage); return 1 }

  const path = scratchPath('chsh')
  await custom('users_chsh', username, shellValue, path)
  const { error, message } = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  if (error) { stderr(`chsh: ${error}`); return 1 }
  write(1, encoder.encode(message + '\n'))
  return 0
}

try {
  exit(await main())
} catch (error) {
  stderr(`chsh: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
