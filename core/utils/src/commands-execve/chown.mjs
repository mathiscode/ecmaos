/**
 * Real `execve`'d `chown` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/chown.ts`) per `feat/1.0.0-execve-commands`. `kernel.users` username/gid
 * resolution is replaced by the `users_lookup` custom syscall `id.mjs`/`groups.mjs` already use (see
 * `id.mjs`'s doc comment for why this needs a main-thread round-trip rather than a real syscall --
 * there's no execve-compatible way to query the live `kernel.users` registry otherwise). The actual
 * ownership change uses the real `chown` syscall (`@zenfs/linux` already had one; it just wasn't yet
 * exposed on `ecmaosSyscalls` -- added alongside `chmod` in `node.mjs`, same as `link`/`symlink`/
 * `readlink`/`lstat` were added for earlier migrations).
 *
 * Note: `-R` on a directory itself always fails with `EISDIR` -- `@zenfs/core`'s `chown` (both the
 * real syscall used here and the async `fs.promises.chown` the original in-process version used)
 * opens its target with the `'r+'` flag before chowning it, which a directory can never satisfy.
 * Since `processFile`'s own `chown` call throws before it ever reaches the recursion step below,
 * `chown -R somedir` never touches `somedir`'s contents either -- a genuine pre-existing
 * `@zenfs/core` limitation confirmed identical in its own `promises.js`/`sync.js`, not something
 * introduced by this migration.
 */

import { resolve, join } from './lib/path-utils.mjs'

const { argv, exit, writeAll, read, getcwd, open, close, stat, lstat, isDirectory, readdir, chown, unlink, custom, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: chown [OPTION]... [OWNER][:[GROUP]] FILE...
   or:  chown [OPTION]... :GROUP FILE...
   or:  chown [OPTION]... --reference=RFILE FILE...
Change the owner and/or group of each FILE to OWNER and/or GROUP.

      -R, --recursive     operate on files and directories recursively
      -v, --verbose       output a diagnostic for every file processed
      -c, --changes       like verbose but report only when a change is made
      --help              display this help and exit

OWNER and GROUP can be specified as:
  - A numeric user ID (UID) or group ID (GID)
  - A username (resolved to UID)
  - A group name (resolved to GID, if supported)

The format OWNER:GROUP means set both owner and group.
The format OWNER: means set owner and set group to owner's primary group.
The format :GROUP means set group only (keep current owner).
The format OWNER.GROUP is also accepted (same as OWNER:GROUP).

Examples:
  chown root file                 Change owner of file to root
  chown root:root file            Change owner and group to root
  chown :users file               Change group to users (keep owner)
  chown root: file                Change owner to root, group to root's primary group
  chown -R root:root /dir         Recursively change owner and group
  chown -v user file              Verbose output while changing owner
  chown -c user file              Report only when changes are made`

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

async function resolveOwner(ownerSpec) {
  const numericUid = parseInt(ownerSpec, 10)
  if (!isNaN(numericUid) && numericUid.toString() === ownerSpec) return numericUid

  const user = await usersLookup({ mode: 'byUsername', username: ownerSpec })
  if (!user) throw new Error(`Invalid user: ${ownerSpec}`)
  return user.uid
}

async function resolveGroup(groupSpec) {
  const numericGid = parseInt(groupSpec, 10)
  if (!isNaN(numericGid) && numericGid.toString() === groupSpec) return numericGid

  const user = await usersLookup({ mode: 'byUsername', username: groupSpec })
  if (user) return user.gid

  throw new Error(`Invalid group: ${groupSpec}`)
}

async function parseOwnershipSpec(spec) {
  const result = { ownerOnly: false, groupOnly: false, setGroupToOwnerPrimary: false }

  if (spec.startsWith(':')) {
    result.groupOnly = true
    const groupSpec = spec.slice(1)
    if (!groupSpec) throw new Error('Invalid ownership spec: missing group after colon')
    result.group = await resolveGroup(groupSpec)
    return result
  }

  if (spec.endsWith(':')) {
    result.ownerOnly = true
    result.setGroupToOwnerPrimary = true
    const ownerSpec = spec.slice(0, -1)
    if (!ownerSpec) throw new Error('Invalid ownership spec: missing owner before colon')
    result.owner = await resolveOwner(ownerSpec)
    const ownerUser = await usersLookup({ mode: 'byUid', uid: result.owner })
    if (ownerUser) result.group = ownerUser.gid
    return result
  }

  const colonIndex = spec.indexOf(':')
  const dotIndex = spec.indexOf('.')

  if (colonIndex === -1 && dotIndex === -1) {
    result.owner = await resolveOwner(spec)
    result.ownerOnly = true
    return result
  }

  const separatorIndex = colonIndex !== -1 ? colonIndex : dotIndex
  const ownerSpec = spec.slice(0, separatorIndex)
  const groupSpec = spec.slice(separatorIndex + 1)

  if (!ownerSpec && !groupSpec) throw new Error('Invalid ownership spec: both owner and group are empty')
  if (ownerSpec) result.owner = await resolveOwner(ownerSpec)
  if (groupSpec) result.group = await resolveGroup(groupSpec)

  return result
}

function getCurrentOwnership(filePath) {
  try {
    const s = lstat(filePath)
    return { uid: s.uid, gid: s.gid }
  } catch (error) {
    throw new Error(`Cannot access ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function changeOwnership(filePath, spec) {
  const current = getCurrentOwnership(filePath)
  let newUid = current.uid
  let newGid = current.gid

  if (spec.ownerOnly) {
    newUid = spec.owner ?? current.uid
    if (spec.setGroupToOwnerPrimary && spec.owner !== undefined) {
      const ownerUser = await usersLookup({ mode: 'byUid', uid: spec.owner })
      if (ownerUser) newGid = ownerUser.gid
    } else if (spec.group !== undefined) {
      newGid = spec.group
    }
  } else if (spec.groupOnly) {
    newGid = spec.group ?? current.gid
  } else {
    if (spec.owner !== undefined) newUid = spec.owner
    if (spec.group !== undefined) newGid = spec.group
  }

  chown(filePath, newUid, newGid)
  return { uid: newUid, gid: newGid }
}

async function processFile(filePath, spec, options, relativePath) {
  try {
    const current = getCurrentOwnership(filePath)
    const newOwnership = await changeOwnership(filePath, spec)
    const changed = current.uid !== newOwnership.uid || current.gid !== newOwnership.gid

    if (options.verbose || (options.changes && changed)) {
      const changeInfo = changed
        ? `changed ownership of '${relativePath}' from ${current.uid}:${current.gid} to ${newOwnership.uid}:${newOwnership.gid}`
        : `ownership of '${relativePath}' retained as ${newOwnership.uid}:${newOwnership.gid}`
      writeAll(1, new TextEncoder().encode(changeInfo + '\n'))
    }

    if (options.recursive) {
      try {
        if (isDirectory(filePath)) {
          const entries = readdir(filePath)
          for (const entry of entries) {
            const entryPath = join(filePath, entry)
            const entryRelativePath = join(relativePath, entry)
            await processFile(entryPath, spec, options, entryRelativePath)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeAll(2, new TextEncoder().encode(`chown: ${relativePath}: ${message}\n`))
      }
    }

    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeAll(2, new TextEncoder().encode(`chown: ${relativePath}: ${message}\n`))
    return true
  }
}

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let recursive = false
  let verbose = false
  let changes = false
  const positional = []

  for (const arg of args) {
    if (arg === '-R' || arg === '--recursive') {
      recursive = true
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true
    } else if (arg === '-c' || arg === '--changes') {
      changes = true
    } else if (arg === '--reference') {
      writeAll(2, new TextEncoder().encode('chown: --reference option not yet implemented\n'))
      return 1
    } else if (arg && !arg.startsWith('-')) {
      positional.push(arg)
    } else if (arg.startsWith('-')) {
      writeAll(2, new TextEncoder().encode(`chown: invalid option '${arg}'\nTry 'chown --help' for more information.\n`))
      return 1
    }
  }

  if (positional.length === 0) {
    writeAll(2, new TextEncoder().encode("chown: missing operand\nTry 'chown --help' for more information.\n"))
    return 1
  }

  const ownershipSpec = positional[0]
  const targets = positional.slice(1)

  if (!ownershipSpec || targets.length === 0) {
    writeAll(2, new TextEncoder().encode("chown: missing operand\nTry 'chown --help' for more information.\n"))
    return 1
  }

  let spec
  try {
    spec = await parseOwnershipSpec(ownershipSpec)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeAll(2, new TextEncoder().encode(`chown: invalid ownership spec '${ownershipSpec}': ${message}\n`))
    return 1
  }

  const cwd = getcwd()
  let hasError = false
  const options = { recursive, verbose, changes }

  for (const target of targets) {
    const fullPath = resolve(cwd, target)
    const error = await processFile(fullPath, spec, options, target)
    if (error) hasError = true
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`chown: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
