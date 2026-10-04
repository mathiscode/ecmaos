/** Change a user account: `usermod -aG staff alice`, `usermod -l bob alice`. */

import { getopt, integer } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: usermod [OPTION]... LOGIN
Modify a user account.

  -l, --login NEW_LOGIN     rename the user (the group named after them is renamed too)
  -u, --uid UID             a new user ID (the files in the home directory are handed over)
  -g, --gid GROUP           a new primary group, a name or a number that exists
  -G, --groups GROUPS       supplementary groups, separated by commas (they replace the current ones)
  -a, --append              with -G, add to the current groups instead
  -d, --home HOME_DIR       a new home directory
  -m, --move-home           with -d, move the content of the old home directory
  -s, --shell SHELL         a new login shell
  --help                    display this help and exit

Locking an account (-L, -U) is not supported: a password is the only way in, so change it with passwd.`

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), {
    flags: 'am', values: 'lugGds',
    long: { login: 'l', uid: 'u', gid: 'g', groups: 'G', append: 'a', home: 'd', 'move-home': 'm', shell: 's' }
  })
  if (parsed.error) { say(2, `usermod: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  const { opts, rest } = parsed
  if (rest.length !== 1) { say(2, `usermod: ${rest.length === 0 ? 'no user name given' : 'too many arguments'}\n${usage}\n`); return 2 }
  if (opts.a && opts.G === undefined) { say(2, 'usermod: the -a option is only valid with the -G option\n'); return 2 }
  if (opts.m && opts.d === undefined) { say(2, 'usermod: the -m option is only valid with the -d option\n'); return 2 }
  const uid = opts.u === undefined ? undefined : integer(opts.u)
  if (opts.u !== undefined && uid === undefined) { say(2, `usermod: invalid user ID '${opts.u}'\n`); return 3 }
  return finish('usermod', await manage('usermod', {
    username: rest[0], newName: opts.l, uid, group: opts.g === undefined ? undefined : (integer(opts.g) ?? opts.g),
    groups: opts.G === undefined ? undefined : opts.G.split(',').filter(Boolean).map(spec => integer(spec) ?? spec),
    append: Boolean(opts.a), home: opts.d, moveHome: Boolean(opts.m), shell: opts.s
  }))
}

await start('usermod', main)
