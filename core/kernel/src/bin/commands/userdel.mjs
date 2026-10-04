/** Delete a user account: `userdel -r alice`. */

import { getopt } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: userdel [OPTION]... LOGIN
Delete a user account.

  -r, --remove    also remove the home directory
  -f, --force     remove even when the user has processes running
  --help          display this help and exit

The group named after the user goes too, unless somebody else is in it.`

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), { flags: 'rf', long: { remove: 'r', force: 'f' } })
  if (parsed.error) { say(2, `userdel: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  if (parsed.rest.length !== 1) { say(2, `userdel: ${parsed.rest.length === 0 ? 'no user name given' : 'too many arguments'}\n${usage}\n`); return 2 }
  return finish('userdel', await manage('userdel', { username: parsed.rest[0], removeHome: Boolean(parsed.opts.r), force: Boolean(parsed.opts.f) }))
}

await start('userdel', main)
