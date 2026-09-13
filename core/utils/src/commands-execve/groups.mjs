/**
 * Real `execve`'d `groups` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/groups.ts`) per `feat/1.0.0-execve-commands`. See `id.mjs`'s doc comment
 * for the `users_lookup` custom syscall this uses to resolve usernames/uids/groups against the live
 * `kernel.users` registry a worker has no direct reference to.
 *
 * Note: the original always printed the *calling* process's own `shell.credentials.groups`, even
 * when asked for a different `username` (it looked up the named user only to print their username in
 * the output line, never their actual group membership) -- confirmed by reading the original
 * directly. That's carried over unchanged here, not "fixed," since this is a migration.
 */

const { argv, exit, writeAll, open, read, close, stat, unlink, custom, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: groups [USERNAME]...
Print the groups a user belongs to.

  --help  display this help and exit`

function readWholeFile(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return bytes
}

async function usersLookup(query) {
  const path = `/tmp/.users_lookup-${Math.random().toString(36).slice(2)}`
  await custom('users_lookup', JSON.stringify(query), path)
  try {
    const content = new TextDecoder().decode(readWholeFile(path))
    return JSON.parse(content)
  } finally {
    try { unlink(path) } catch { /* best-effort cleanup */ }
  }
}

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const usernames = []
  for (const arg of args) {
    if (!arg) continue
    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (!arg.startsWith('-')) {
      usernames.push(arg)
    } else {
      writeAll(2, new TextEncoder().encode(`groups: invalid option -- '${arg.slice(1)}'\nTry 'groups --help' for more information.\n`))
      return 1
    }
  }

  const self = await usersLookup({ mode: 'self' })
  const targets = usernames.length > 0 ? usernames : [self.username]

  let output = ''

  for (const username of targets) {
    const user = await usersLookup({ mode: 'byUsername', username })

    if (!user) {
      writeAll(2, new TextEncoder().encode(`groups: '${username}': no such user\n`))
      continue
    }

    const groupNames = []
    for (const gid of self.groups || []) {
      const groupUser = await usersLookup({ mode: 'byUid', uid: gid })
      groupNames.push(groupUser?.username || String(gid))
    }

    output += `${username} : ${groupNames.join(' ')}\n`
  }

  writeAll(1, new TextEncoder().encode(output))
  return 0
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`groups: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
