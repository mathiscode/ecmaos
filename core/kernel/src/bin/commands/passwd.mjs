/**
 * Change the current user's password. Prompts for the current and new password with echo off,
 * like a real `passwd`; `passwd OLD NEW` skips the prompts.
 */
import { echoOff, isTty } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'
import { getopt } from './lib/getopt.mjs'
import { manage } from './lib/accounts.mjs'

const { argv, exit, write, read, custom, open, close, unlink } = globalThis.ecmaosSyscalls

const usage = `Usage: passwd [OLD NEW]
       passwd -l|-u|-S LOGIN
Change your password. Without arguments, prompts for the current and the new password.
Root can lock, unlock and show the state of another account's password:

  -l, --lock      lock the password (a ! before the hash): no password login
  -u, --unlock    unlock it again
  -S, --status    show its state: L locked, P usable, NP none; then the last change and the aging fields
  --help          display this help and exit`

/** `passwd -l|-u|-S LOGIN`, which only root may ask for */
async function account(op, login) {
  const result = await manage('passwd', { username: login, op })
  if (result.error) { stderr(`passwd: ${result.error}`); return 1 }
  if (op === 'status') {
    const { lastChange, min = -1, max = -1, warn = -1, inactive = -1 } = result.aging
    const day = lastChange === undefined ? 'never' : new Date(lastChange * 86_400_000).toISOString().slice(0, 10)
    write(1, encoder.encode(`${login} ${result.state} ${day} ${min} ${max} ${warn} ${inactive}\n`))
  } else stderr('passwd: password expiry information changed.')
  return 0
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const stderr = text => write(2, encoder.encode(text + '\n'))

/** Prints `prompt` and reads one line from stdin, with echo off when stdin is a terminal. */
function readSecret(prompt) {
  write(1, encoder.encode(`\x1b[36m${prompt}\x1b[0m`))
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
  if (isTty(0)) write(1, encoder.encode('\n'))
  return decoder.decode(new Uint8Array(bytes)).replace(/[\r\n]+$/, '')
}

async function main() {
  const args = argv.slice(1)
  if (args[0] === '--help' || args[0] === '-h') {
    stderr(usage)
    return 0
  }

  if (args[0]?.startsWith('-')) {
    const parsed = getopt(args, { flags: 'luS', long: { lock: 'l', unlock: 'u', status: 'S' } })
    if (parsed.error) { stderr(`passwd: ${parsed.error}\n${usage}`); return 2 }
    const ops = ['l', 'u', 'S'].filter(letter => parsed.opts[letter])
    if (ops.length !== 1 || parsed.rest.length !== 1) { stderr(usage); return 2 }
    return account({ l: 'lock', u: 'unlock', S: 'status' }[ops[0]], parsed.rest[0])
  }

  let oldPass
  let newPass

  if (args.length < 2) {
    oldPass = readSecret('Enter current password: ')
    if (!oldPass) {
      stderr('\x1b[31mCurrent password required\x1b[0m')
      return 1
    }
    newPass = readSecret('Enter new password: ')
    if (!newPass) {
      stderr('\x1b[31mNew password required\x1b[0m')
      return 1
    }
    if (newPass !== readSecret('Confirm new password: ')) {
      stderr('\x1b[31mPasswords do not match\x1b[0m')
      return 1
    }
  } else {
    [oldPass, newPass] = args
  }

  const path = scratchPath('passwd')
  await custom('users_password', oldPass, newPass, path)
  const { error } = JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
  if (error) {
    stderr(`\x1b[31mFailed to update password: ${error}\x1b[0m`)
    return 1
  }
  write(1, encoder.encode('\x1b[32mPassword updated successfully\x1b[0m\n'))
  return 0
}

try {
  exit(await main())
} catch (error) {
  stderr(`passwd: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
