/** Delete a group: `groupdel staff`. */

import { getopt } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: groupdel GROUP
Delete a group. A user's primary group cannot be deleted while the user exists.

  --help  display this help and exit`

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), {})
  if (parsed.error) { say(2, `groupdel: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  if (parsed.rest.length !== 1) { say(2, `groupdel: ${parsed.rest.length === 0 ? 'no group name given' : 'too many arguments'}\n${usage}\n`); return 2 }
  return finish('groupdel', await manage('groupdel', { name: parsed.rest[0] }))
}

await start('groupdel', main)
