/** Change a group: `groupmod -n crew staff`. */

import { getopt, integer } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: groupmod [OPTION]... GROUP
Modify a group.

  -n, --new-name NEW_GROUP   rename the group
  -g, --gid GID              give the group another ID; its members follow, files keep the ID they have
  --help                     display this help and exit`

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), { values: 'gn', long: { gid: 'g', 'new-name': 'n' } })
  if (parsed.error) { say(2, `groupmod: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  if (parsed.rest.length !== 1) { say(2, `groupmod: ${parsed.rest.length === 0 ? 'no group name given' : 'too many arguments'}\n${usage}\n`); return 2 }
  const gid = parsed.opts.g === undefined ? undefined : integer(parsed.opts.g)
  if (parsed.opts.g !== undefined && gid === undefined) { say(2, `groupmod: invalid group ID '${parsed.opts.g}'\n`); return 3 }
  return finish('groupmod', await manage('groupmod', { name: parsed.rest[0], gid, newName: parsed.opts.n }))
}

await start('groupmod', main)
