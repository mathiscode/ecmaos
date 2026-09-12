/**
 * Real `execve`'d `readlink` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/readlink.ts`) per `feat/1.0.0-execve-commands`. Needed a real
 * `readlink` syscall this interpreter didn't expose yet -- added to `globalThis.ecmaosSyscalls` in
 * `/bin/node.mjs` (a plain pass-through of `@zenfs/linux`'s own `readlink`, same as `link`/`symlink`
 * added alongside it for `ln`).
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, getcwd, readlink } = globalThis.ecmaosSyscalls

const usage = `Usage: readlink [OPTION]... FILE...
Print value of a symbolic link or canonical file name.

  -f, --canonicalize      canonicalize by following every symlink in every component
  -e, --canonicalize-existing  canonicalize by following every symlink in every component that exists
  -m, --canonicalize-missing   canonicalize by following every symlink in every component, without requirements on components existence
  --help                  display this help and exit`

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let canonicalize = false
  let canonicalizeExisting = false
  let canonicalizeMissing = false
  const files = []

  for (const arg of args) {
    if (arg === '-f' || arg === '--canonicalize') canonicalize = true
    else if (arg === '-e' || arg === '--canonicalize-existing') canonicalizeExisting = true
    else if (arg === '-m' || arg === '--canonicalize-missing') canonicalizeMissing = true
    else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('f')) canonicalize = true
      if (flags.includes('e')) canonicalizeExisting = true
      if (flags.includes('m')) canonicalizeMissing = true
      const invalid = flags.find(f => !['f', 'e', 'm'].includes(f))
      if (invalid) {
        write(2, new TextEncoder().encode(`readlink: invalid option -- '${invalid}'\n`))
        write(2, new TextEncoder().encode("Try 'readlink --help' for more information.\n"))
        return 1
      }
    } else {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    write(2, new TextEncoder().encode('readlink: missing operand\n'))
    write(2, new TextEncoder().encode("Try 'readlink --help' for more information.\n"))
    return 1
  }

  const cwd = getcwd()
  let hasError = false
  let output = ''

  for (const file of files) {
    const fullPath = resolve(cwd, file)
    try {
      if (canonicalize || canonicalizeExisting || canonicalizeMissing) {
        output += fullPath + '\n'
      } else {
        output += readlink(fullPath) + '\n'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = message.includes('EINVAL') ? 'invalid symlink'
        : message.includes('ENOENT') ? 'No such file or directory'
        : message
      write(2, new TextEncoder().encode(`readlink: ${file}: ${reason}\n`))
      hasError = true
    }
  }
  write(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`readlink: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
