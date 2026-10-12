/**
 * Prints the groups a user belongs to. `groups <username>` prints the calling user's groups; the name only labels the
 * output.
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

    // Primary group first, then supplementary - `self.groups` holds only the latter, so listing it
    // alone printed an empty list for any user with no supplementary memberships.
    const gids = [user.gid, ...(user.groups || []).filter(gid => gid !== user.gid)]
    const groupNames = []
    for (const gid of gids) {
      const group = await usersLookup({ mode: 'group', gid })
      groupNames.push(group?.name || String(gid))
    }

    // GNU `groups` prints the bare list for the calling user and prefixes `username : ` only when
    // usernames were named explicitly.
    output += usernames.length > 0
      ? `${username} : ${groupNames.join(' ')}\n`
      : `${groupNames.join(' ')}\n`
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
