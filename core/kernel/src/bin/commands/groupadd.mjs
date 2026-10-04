/** Create a group: `groupadd staff`. */

import { getopt, integer } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: groupadd [OPTION]... GROUP
Create a new group.

  -g, --gid GID    the group ID (default: the first free one from 1000)
  -r, --system     a system group: an ID from 100 to 999
  -f, --force      succeed, doing nothing, if the group already exists
  --help           display this help and exit`

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), { flags: 'rf', values: 'g', long: { gid: 'g', system: 'r', force: 'f' } })
  if (parsed.error) { say(2, `groupadd: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  if (parsed.rest.length !== 1) { say(2, `groupadd: ${parsed.rest.length === 0 ? 'no group name given' : 'too many arguments'}\n${usage}\n`); return 2 }
  const gid = parsed.opts.g === undefined ? undefined : integer(parsed.opts.g)
  if (parsed.opts.g !== undefined && gid === undefined) { say(2, `groupadd: invalid group ID '${parsed.opts.g}'\n`); return 3 }
  return finish('groupadd', await manage('groupadd', { name: parsed.rest[0], gid, system: Boolean(parsed.opts.r), force: Boolean(parsed.opts.f) }))
}

await start('groupadd', main)
