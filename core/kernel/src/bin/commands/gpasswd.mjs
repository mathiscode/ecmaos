/** Administer a group's members: `gpasswd -a alice staff`. */

import { getopt } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: gpasswd [OPTION] GROUP
Administer the members of a group.

  -a, --add USER       add USER to the group
  -d, --delete USER    remove USER from the group
  -M, --members LIST   make exactly these users (separated by commas) the members
  --help               display this help and exit

Group passwords (newgrp) are not supported.`

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), { values: 'adM', long: { add: 'a', delete: 'd', members: 'M' } })
  if (parsed.error) { say(2, `gpasswd: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  const { opts, rest } = parsed
  if (rest.length !== 1) { say(2, `gpasswd: ${rest.length === 0 ? 'no group name given' : 'too many arguments'}\n${usage}\n`); return 2 }
  const given = ['a', 'd', 'M'].filter(letter => opts[letter] !== undefined)
  if (given.length !== 1) { say(2, `gpasswd: one of -a, -d and -M is needed\n${usage}\n`); return 2 }
  if (opts.M !== undefined) return finish('gpasswd', await manage('members', { group: rest[0], users: opts.M.split(',').filter(Boolean) }))
  return finish('gpasswd', await manage('member', { group: rest[0], user: opts.a ?? opts.d, op: opts.a !== undefined ? 'add' : 'remove' }))
}

await start('gpasswd', main)
