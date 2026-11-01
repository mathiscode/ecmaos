/** Set passwords in bulk: `echo 'alice:s3cret' | chpasswd`. Root only; one `user:password` per line on standard input. */

import { finish, manage, say, start } from './lib/accounts.mjs'

const { argv, read } = globalThis.ecmaosSyscalls

const usage = `Usage: chpasswd [options]
Update the passwords of many accounts, from lines of USER:PASSWORD on standard input.

  -e, --encrypted   the passwords are already hashed (not supported: they are hashed here)
  --help            display this help and exit`

function lines() {
  const chunks = []
  const buffer = new Uint8Array(4096)
  for (;;) {
    const count = read(0, buffer, -1)
    if (count <= 0) break
    chunks.push(buffer.slice(0, count))
  }
  const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length }
  return new TextDecoder().decode(all).split('\n')
}

await start('chpasswd', async () => {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) { say(1, usage + '\n'); return 0 }
  const unknown = args.find(arg => !['-e', '--encrypted', '-m', '--md5', '-c', '--crypt-method', '-s', '--sha-rounds'].includes(arg) && !/^(SHA|MD5|DES|YESCRYPT|\d)/.test(arg))
  if (unknown) { say(2, `chpasswd: unrecognized option '${unknown}'\n${usage}\n`); return 1 }
  if (args.includes('-e') || args.includes('--encrypted')) { say(2, 'chpasswd: encrypted passwords are not supported\n'); return 1 }

  let failed = false
  let number = 0
  for (const line of lines()) {
    number++
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon < 1) { say(2, `chpasswd: line ${number}: missing new password\n`); failed = true; continue }
    const result = await manage('passwd', { username: line.slice(0, colon), op: 'set', password: line.slice(colon + 1) })
    if (finish(`chpasswd: line ${number}`, result)) failed = true
  }
  return failed ? 1 : 0
})
