/**
 * Real `execve`'d `passkey`. WebAuthn (`navigator.credentials`) only exists in the top-level
 * browsing context, so the work runs main-thread side through the `auth_passkey` syscall
 * (`#lib/passkey-manage.ts`); this program only parses arguments and prints what comes back.
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const { argv, exit, write, custom, open, read, close, unlink } = globalThis.ecmaosSyscalls

const usage = `Usage: passkey <subcommand> [options]

Subcommands:
  register [--name <name>]    Register a new passkey
  list                        List all registered passkeys
  remove --id <id>            Remove a specific passkey
  remove-all                  Remove all passkeys

  --help  display this help and exit`

const encoder = new TextEncoder()

async function main() {
  const args = argv.slice(1)

  if (args[0] === '--help' || args[0] === '-h') {
    write(2, encoder.encode(usage + '\n'))
    return 0
  }

  if (args.length === 0 || !args[0] || args[0].toLowerCase() === 'help') {
    write(2, encoder.encode(usage + '\n'))
    return 0
  }

  const subcommand = args[0].toLowerCase()
  let name
  let id

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--name' && i + 1 < args.length) name = args[++i]
    else if (arg.startsWith('--name=')) name = arg.slice(7)
    else if (arg === '--id' && i + 1 < args.length) id = args[++i]
    else if (arg.startsWith('--id=')) id = arg.slice(5)
  }

  const path = scratchPath('passkey')
  await custom('auth_passkey', JSON.stringify({ subcommand, name, id }), path)
  const { code, lines } = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))

  for (const { stream, text } of lines) write(stream === 'err' ? 2 : 1, encoder.encode(text + '\n'))
  return code
}

try {
  exit(await main())
} catch (error) {
  write(2, encoder.encode(`passkey: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
