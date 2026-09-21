/**
 * Real `execve`'d `umount` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/umount.ts`) per this session's M1 pass. `kernel.filesystem.mounts`/
 * `kernel.filesystem.fsSync.umount()` are live `Kernel` state a worker can't see directly, reached
 * through the `fs_umount` custom syscall (`#lib/main-thread-syscalls.ts`), which also does the
 * whole `-a` loop main-thread side rather than making this program call it once per mount point.
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const { argv, exit, write, custom, open, read, close, unlink } = globalThis.ecmaosSyscalls

const usage = `Usage: umount [OPTIONS] TARGET
       umount [-a|--all]

Unmount a filesystem.

Options:
  -a, --all    unmount all filesystems (except root)
  --help       display this help and exit

Examples:
  umount /mnt/tmp        unmount filesystem at /mnt/tmp
  umount -a              unmount all filesystems`

function writeln(fd, text) {
  write(fd, new TextEncoder().encode(text + '\n'))
}

async function main() {
  const args = argv.slice(1)

  if (args.includes('--help') || args.includes('-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let allMode = false
  const positional = []
  for (const arg of args) {
    if (arg === '-a' || arg === '--all') allMode = true
    else if (!arg.startsWith('-')) positional.push(arg)
  }

  if (!allMode && positional.length === 0) {
    writeln(2, 'umount: missing target argument')
    writeln(2, "Try 'umount --help' for more information.")
    return 1
  }

  if (!allMode && positional.length > 1) {
    writeln(2, 'umount: too many arguments')
    writeln(2, "Try 'umount --help' for more information.")
    return 1
  }

  const target = allMode ? '' : positional[0]
  const path = scratchPath('umount')
  await custom('fs_umount', target, path)
  const text = await readBackAndDelete({ open, read, close, unlink }, path)
  const results = JSON.parse(text)

  if (results.length === 0) {
    writeln(1, 'No filesystems to unmount.')
    return 0
  }

  let hasError = false
  for (const result of results) {
    if (result.error) {
      hasError = true
      writeln(2, `umount: failed to unmount ${result.target}: ${result.error}`)
    } else {
      writeln(1, `Unmounted ${result.target}`)
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`umount: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
