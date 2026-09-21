/**
 * Real `execve`'d `passwd`. Prompts on the terminal with echo off (the line discipline's `ECHO`
 * flag, the same way real `passwd` does it) and hands the two passwords to the `users_password`
 * syscall, which changes the password of the user the kernel is running as; `passwd OLD NEW` skips
 * the prompts.
 */
import { echoOff, isTty } from '../../../../utils/src/commands-execve/lib/tty.mjs'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const { argv, exit, write, read, custom, open, close, unlink } = globalThis.ecmaosSyscalls

const usage = `Usage: passwd [OLD NEW]
Change your password. Without arguments, prompts for the current and the new password.

  --help  display this help and exit`

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
