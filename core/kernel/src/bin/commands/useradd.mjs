/** Create a user account: `useradd -m -G staff alice`. */

import { getopt, integer } from './lib/getopt.mjs'
import { finish, manage, say, start } from './lib/accounts.mjs'

const usage = `Usage: useradd [OPTION]... LOGIN
Create a new user.

  -m, --create-home         create the home directory
  -d, --home-dir HOME_DIR   the home directory (default /home/LOGIN)
  -s, --shell SHELL         the login shell (default ecmaos, the shell built into the kernel)
  -u, --uid UID             the user ID (default: the first free one from 1000)
  -g, --gid GROUP           the primary group, a name or a number that exists (default: a new group named LOGIN)
  -G, --groups GROUPS       supplementary groups, separated by commas
  -r, --system              a system account: an ID from 100 to 999, no home directory unless -m
  -p, --password PASSWORD   the password in plain text (asked for when not given)
  --help                    display this help and exit

Unlike Linux, an account has to have a password, so one is asked for when there is no -p.`

async function main() {
  const parsed = getopt(globalThis.ecmaosSyscalls.argv.slice(1), {
    flags: 'mr', values: 'dsugGp',
    long: { 'create-home': 'm', 'home-dir': 'd', shell: 's', uid: 'u', gid: 'g', groups: 'G', system: 'r', password: 'p' }
  })
  if (parsed.error) { say(2, `useradd: ${parsed.error}\n`); return 2 }
  if (parsed.opts.help) { say(1, usage + '\n'); return 0 }
  const { opts, rest } = parsed
  if (rest.length !== 1) { say(2, `useradd: ${rest.length === 0 ? 'no user name given' : 'too many arguments'}\n${usage}\n`); return 2 }
  const uid = opts.u === undefined ? undefined : integer(opts.u)
  if (opts.u !== undefined && uid === undefined) { say(2, `useradd: invalid user ID '${opts.u}'\n`); return 3 }
  const result = await manage('useradd', {
    username: rest[0], uid, group: opts.g === undefined ? undefined : (integer(opts.g) ?? opts.g), groups: opts.G === undefined ? undefined : opts.G.split(',').filter(Boolean).map(spec => integer(spec) ?? spec),
    shell: opts.s, home: opts.d, createHome: Boolean(opts.m), system: Boolean(opts.r), password: opts.p
  })
  return finish('useradd', result)
}

await start('useradd', main)
