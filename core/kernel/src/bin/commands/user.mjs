/**
 * Real `execve`'d `user` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/user.ts`) per this session's M1 pass. `kernel.users` (add/remove/update/
 * list), the `suid !== 0` permission check, and the interactive password prompt
 * (`shell.terminal.readline()`) are all live, main-thread-only state a worker can't reach directly --
 * all four subcommands (`list`/`add`/`del`/`mod`) reach the same new `users_manage` syscall
 * (`#lib/main-thread-syscalls.ts`), using `lib/scratch.mjs`'s shared scratch-file bridge the same way
 * `df.mjs`/`ps.mjs`/`sockets.mjs` do. `list` isn't routed through the existing `users_lookup` syscall
 * (`id.mjs`/`groups.mjs`'s own) even though its read-only shape is identical -- see
 * `users_manage`'s own doc comment for why: `list` needs the same permission gate `add`/`del`/`mod`
 * do, and `users_lookup`'s other modes are deliberately permission-free.
 *
 * CLI parsing (flags, positional username) stays here, unprivileged -- only the actual mutation, the
 * permission check, and any interactive password prompt happen inside the syscall handler on the
 * main thread, since only it can reach `shell.terminal`. No ANSI colour here, same as every other
 * migrated coreutil (`ls.mjs`/`ps.mjs`/`sockets.mjs`).
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, custom } = syscalls

const usage = `Usage: user [COMMAND] [OPTIONS] [USERNAME]
Manage users on the system.

Commands:
  add USERNAME     Add a new user
  del USERNAME     Delete a user
  mod USERNAME     Modify a user
  list             List all users (default)

Options for 'add':
  -m, --create-home    Create home directory
  -s, --shell SHELL    Login shell (default: ecmaos)
  -g, --gid GID        Group ID (default: same as UID)
  -u, --uid UID        User ID (default: auto-assigned)
  -p, --password PASS  Password (will prompt if not provided)

Options for 'del':
  -r, --remove-home    Remove home directory

Options for 'mod':
  -s, --shell SHELL    Change login shell
  -g, --gid GID        Change group ID
  -p, --password       Change password (will prompt)

  --help               Display this help and exit`

async function listUsers() {
  const users = await manage('list', {})
  if (users.error) { write(2, new TextEncoder().encode(`user: ${users.error}\n`)); return 1 }

  if (users.length === 0) {
    write(1, new TextEncoder().encode('No users found\n'))
    return 0
  }

  const uidWidth = Math.max(3, ...users.map(u => u.uid.toString().length))
  const usernameWidth = Math.max(8, ...users.map(u => u.username.length))
  const gidWidth = Math.max(3, ...users.map(u => u.gid.toString().length))

  const lines = ['UID'.padEnd(uidWidth) + '\t' + 'Username'.padEnd(usernameWidth) + '\t' + 'GID'.padEnd(gidWidth) + '\t' + 'Groups']
  for (const usr of users) {
    lines.push(
      usr.uid.toString().padEnd(uidWidth) + '\t' +
      usr.username.padEnd(usernameWidth) + '\t' +
      usr.gid.toString().padEnd(gidWidth) + '\t' +
      (usr.groups.join(', ') || '-')
    )
  }

  write(1, new TextEncoder().encode(lines.join('\n') + '\n'))
  return 0
}

async function manage(action, args) {
  const path = scratchPath(`user-${action}`)
  await custom('users_manage', action, JSON.stringify(args), path)
  const raw = await readBackAndDelete(syscalls, path)
  return JSON.parse(raw)
}

function parseFlags(args, spec) {
  const result = { positional: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--help' || arg === '-h') return { help: true }
    if (!arg.startsWith('-')) { result.positional.push(arg); continue }

    const flag = spec[arg]
    if (!flag) return { error: `invalid option -- '${arg.replace(/^-+/, '')}'` }
    if (flag.takesValue) {
      const value = args[++i]
      if (!value) return { error: `option requires an argument -- '${arg.replace(/^-+/, '')}'` }
      result[flag.name] = value
    } else {
      result[flag.name] = true
    }
  }
  return result
}

async function addUser(args) {
  const parsed = parseFlags(args, {
    '-m': { name: 'createHome' }, '--create-home': { name: 'createHome' },
    '-s': { name: 'shellValue', takesValue: true }, '--shell': { name: 'shellValue', takesValue: true },
    '-g': { name: 'gid', takesValue: true }, '--gid': { name: 'gid', takesValue: true },
    '-u': { name: 'uid', takesValue: true }, '--uid': { name: 'uid', takesValue: true },
    '-p': { name: 'password', takesValue: true }, '--password': { name: 'password', takesValue: true }
  })
  if (parsed.help) { write(2, new TextEncoder().encode(usage + '\n')); return 0 }
  if (parsed.error) { write(2, new TextEncoder().encode(`user add: ${parsed.error}\n`)); return 1 }

  const username = parsed.positional[0]
  if (!username) {
    write(2, new TextEncoder().encode('user add: username required\n'))
    write(1, new TextEncoder().encode("Try 'user add --help' for more information.\n"))
    return 1
  }

  if (parsed.gid !== undefined) {
    const gid = parseInt(parsed.gid, 10)
    if (Number.isNaN(gid)) { write(2, new TextEncoder().encode(`user add: invalid GID '${parsed.gid}'\n`)); return 1 }
    parsed.gid = gid
  }
  if (parsed.uid !== undefined) {
    const uid = parseInt(parsed.uid, 10)
    if (Number.isNaN(uid)) { write(2, new TextEncoder().encode(`user add: invalid UID '${parsed.uid}'\n`)); return 1 }
    parsed.uid = uid
  }

  const result = await manage('add', { username, createHome: !!parsed.createHome, shellValue: parsed.shellValue ?? 'ecmaos', gid: parsed.gid, uid: parsed.uid, password: parsed.password })
  if (result.error) { write(2, new TextEncoder().encode(`user add: ${result.error}\n`)); return 1 }
  write(1, new TextEncoder().encode(`user add: ${result.message}\n`))
  return 0
}

async function delUser(args) {
  const parsed = parseFlags(args, {
    '-r': { name: 'removeHome' }, '--remove-home': { name: 'removeHome' }
  })
  if (parsed.help) { write(2, new TextEncoder().encode(usage + '\n')); return 0 }
  if (parsed.error) { write(2, new TextEncoder().encode(`user del: ${parsed.error}\n`)); return 1 }

  const username = parsed.positional[0]
  if (!username) {
    write(2, new TextEncoder().encode('user del: username required\n'))
    write(1, new TextEncoder().encode("Try 'user del --help' for more information.\n"))
    return 1
  }

  const result = await manage('del', { username, removeHome: !!parsed.removeHome })
  if (result.error) { write(2, new TextEncoder().encode(`user del: ${result.error}\n`)); return 1 }
  if (result.warning) write(2, new TextEncoder().encode(`user del: ${result.warning}\n`))
  write(1, new TextEncoder().encode(`user del: ${result.message}\n`))
  return 0
}

async function modUser(args) {
  const parsed = parseFlags(args, {
    '-s': { name: 'shellValue', takesValue: true }, '--shell': { name: 'shellValue', takesValue: true },
    '-g': { name: 'gid', takesValue: true }, '--gid': { name: 'gid', takesValue: true },
    '-p': { name: 'changePassword' }, '--password': { name: 'changePassword' }
  })
  if (parsed.help) { write(2, new TextEncoder().encode(usage + '\n')); return 0 }
  if (parsed.error) { write(2, new TextEncoder().encode(`user mod: ${parsed.error}\n`)); return 1 }

  const username = parsed.positional[0]
  if (!username) {
    write(2, new TextEncoder().encode('user mod: username required\n'))
    write(1, new TextEncoder().encode("Try 'user mod --help' for more information.\n"))
    return 1
  }

  if (parsed.gid !== undefined) {
    const gid = parseInt(parsed.gid, 10)
    if (Number.isNaN(gid)) { write(2, new TextEncoder().encode(`user mod: invalid GID '${parsed.gid}'\n`)); return 1 }
    parsed.gid = gid
  }

  const result = await manage('mod', { username, shellValue: parsed.shellValue, gid: parsed.gid, changePassword: !!parsed.changePassword })
  if (result.error) { write(2, new TextEncoder().encode(`user mod: ${result.error}\n`)); return 1 }
  write(1, new TextEncoder().encode(`user mod: ${result.message}\n`))
  return 0
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const command = args.length > 0 && args[0] && !args[0].startsWith('-') ? args[0] : 'list'
  const remainingArgs = command !== 'list' ? args.slice(1) : args

  switch (command) {
    case 'list': return await listUsers()
    case 'add': return await addUser(remainingArgs)
    case 'del': return await delUser(remainingArgs)
    case 'mod': return await modUser(remainingArgs)
    default:
      write(2, new TextEncoder().encode(`user: invalid command '${command}'\n`))
      write(1, new TextEncoder().encode("Try 'user --help' for more information.\n"))
      return 1
  }
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`user: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
