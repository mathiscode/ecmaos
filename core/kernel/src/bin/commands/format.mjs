/**
 * Real `execve`'d `format` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/format.ts`). The permission check, the interactive yes/no confirmation
 * prompt, and the actual `indexedDB`/`localStorage` wipe are all live, main-thread-only state a
 * worker can't reach directly -- all of it (CLI parsing stays here, unprivileged) reaches the new
 * `system_format` custom syscall (`#lib/main-thread-syscalls.ts`), using `lib/scratch.mjs`'s shared
 * scratch-file bridge the same way `user.mjs`/`df.mjs`/`ps.mjs` do. On success, `format` finishes by
 * calling the existing `reboot` syscall (`reboot.mjs`'s own), matching the legacy command's own
 * "format then reboot" sequence without duplicating `kernel.reboot()`'s shutdown logic here.
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, custom } = syscalls

const usage = `Usage: format [OPTION]...
Delete all IndexedDB and localStorage data.

  -i, --indexeddb        Delete only IndexedDB databases
  -l, --localstorage     Delete only localStorage
  -k, --keep <name>      Preserve specific IndexedDB database(s) (can be used multiple times)
  --help                 Display this help and exit

By default, deletes all IndexedDB databases and localStorage.
Requires root privileges and interactive confirmation.`

function writeStdout(text) { write(1, new TextEncoder().encode(text + '\n')) }
function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeStderr(usage)
    return 0
  }

  let onlyIndexedDB = false
  let onlyLocalStorage = false
  const keep = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '-i' || arg === '--indexeddb') {
      onlyIndexedDB = true
    } else if (arg === '-l' || arg === '--localstorage') {
      onlyLocalStorage = true
    } else if (arg === '-k' || arg === '--keep') {
      const dbName = args[++i]
      if (!dbName || dbName.startsWith('-')) {
        writeStderr('format: --keep requires a database name')
        return 1
      }
      keep.push(dbName)
    } else if (arg.startsWith('-')) {
      writeStderr(`format: invalid option -- '${arg.replace(/^-+/, '')}'`)
      writeStdout("Try 'format --help' for more information.")
      return 1
    }
  }

  if (onlyIndexedDB && onlyLocalStorage) {
    writeStderr('format: cannot specify both --indexeddb and --localstorage')
    return 1
  }

  const deleteIndexedDB = !onlyLocalStorage
  const deleteLocal = !onlyIndexedDB

  let actionDescription = 'This will delete '
  if (deleteIndexedDB && deleteLocal) actionDescription += 'ALL IndexedDB databases and localStorage data'
  else if (deleteIndexedDB) actionDescription += 'ALL IndexedDB databases'
  else actionDescription += 'ALL localStorage data'

  if (keep.length > 0) actionDescription += ` (preserving: ${keep.join(', ')})`
  actionDescription += '. This action cannot be undone!'

  writeStderr(`WARNING: ${actionDescription}`)

  const path = scratchPath('format')
  await custom('system_format', JSON.stringify({ indexedDB: deleteIndexedDB, localStorage: deleteLocal, keep }), path)
  const raw = await readBackAndDelete(syscalls, path)
  const result = JSON.parse(raw)

  if (result.error) {
    writeStderr(`format: ${result.error}`)
    return 1
  }

  if (result.cancelled) {
    writeStdout('format: Operation cancelled')
    return 0
  }

  for (const message of result.messages ?? []) writeStdout(`format: ${message}`)

  writeStdout('format: Format operation completed successfully')
  writeStdout('format: Rebooting system to complete format...')
  await custom('reboot')
  return 0
}

try {
  exit(await main())
} catch (error) {
  writeStderr(`format: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
