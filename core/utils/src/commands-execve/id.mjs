/**
 * Real `execve`'d `id` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/id.ts`) per `feat/1.0.0-execve-commands`. `kernel.users.get(uid)` and
 * `shell.credentials` are both live main-thread state a worker has no direct reference to -- resolved
 * instead through the new `users_lookup` custom syscall (`core/kernel/src/tree/lib/
 * main-thread-syscalls.ts`), the same `custom`/`syscall_async` mechanism `window_create`/
 * `storage_usage`/`ps_list` already use for main-thread-only capabilities. Like `storage_usage`/
 * `ps_list`, the syscall can only return a number, so the actual JSON result is written to a real
 * temp file and read back with plain `open`/`read`/`close`.
 */

const { argv, exit, writeAll, open, read, close, stat, unlink, custom, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: id [OPTION]...
Print user and group IDs.

  -u, --user     print only the effective user ID
  -g, --group    print only the effective group ID
  -G, --groups   print all group IDs
  -n, --name     print names instead of numeric IDs
  --help         display this help and exit`

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

  let userOnly = false
  let groupOnly = false
  let groupsOnly = false
  let nameOnly = false

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-u' || arg === '--user') {
      userOnly = true
    } else if (arg === '-g' || arg === '--group') {
      groupOnly = true
    } else if (arg === '-G' || arg === '--groups') {
      groupsOnly = true
    } else if (arg === '-n' || arg === '--name') {
      nameOnly = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('u')) userOnly = true
      if (flags.includes('g')) groupOnly = true
      if (flags.includes('G')) groupsOnly = true
      if (flags.includes('n')) nameOnly = true
      const invalid = flags.find(f => !['u', 'g', 'G', 'n'].includes(f))
      if (invalid) {
        writeAll(1, new TextEncoder().encode(`id: invalid option -- '${invalid}'\n`))
        return 1
      }
    }
  }

  const self = await usersLookup({ mode: 'self' })
  const groupRecord = await usersLookup({ mode: 'byUid', uid: self.gid })
  const groups = self.groups || []

  const resolveGroupName = async (gid) => {
    const record = await usersLookup({ mode: 'byUid', uid: gid })
    return record?.username || String(gid)
  }

  let output

  if (userOnly) {
    output = nameOnly ? (self.username || String(self.uid)) : String(self.euid)
  } else if (groupOnly) {
    output = nameOnly ? (groupRecord?.username || String(self.gid)) : String(self.egid)
  } else if (groupsOnly) {
    const parts = []
    for (const gid of groups) parts.push(nameOnly ? await resolveGroupName(gid) : String(gid))
    output = parts.join(' ')
  } else {
    const uidStr = nameOnly ? (self.username || String(self.uid)) : String(self.uid)
    const gidStr = nameOnly ? (groupRecord?.username || String(self.gid)) : String(self.gid)
    const groupParts = []
    for (const gid of groups) groupParts.push(nameOnly ? await resolveGroupName(gid) : String(gid))
    output = `uid=${uidStr} gid=${gidStr} groups=${groupParts.join(',')}`
  }

  writeAll(1, new TextEncoder().encode(output + '\n'))
  return 0
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`id: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
