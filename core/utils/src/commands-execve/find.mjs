/**
 * Real `execve`'d `find` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/find.ts`) per `feat/1.0.0-execve-commands`. Recursive directory walk is
 * userspace (`readdir` + recurse), same as every real `find` -- there is no recursive-listing
 * syscall. Needed a real `lstat`-backed `isSymbolicLink` this interpreter didn't expose yet (`stat`
 * alone follows a symlink, so it can't tell `-type l` apart from whatever the link points at) --
 * added alongside `isDirectory` in `/bin/node.mjs`, same pattern. See `cat.mjs`'s doc comment for why
 * there's no in-band interrupt handling anymore.
 */

import { resolve, join } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, stat, isDirectory, isSymbolicLink, readdir } = globalThis.ecmaosSyscalls

const usage = `Usage: find [PATH]... [OPTION]...
Search for files in a directory hierarchy.

  -name PATTERN  file name matches shell pattern PATTERN
  -type TYPE     file is of type TYPE (f=file, d=directory, l=symlink)
  --help         display this help and exit`

function matchesPattern(filename, pattern) {
  if (!pattern) return false
  let regexPattern = ''
  for (const char of pattern) {
    if (char === '*') regexPattern += '.*'
    else if (char === '?') regexPattern += '.'
    else if (char === '.') regexPattern += '\\.'
    else regexPattern += /[+^${}()|[\]\\]/.test(char) ? '\\' + char : char
  }
  try {
    return new RegExp(`^${regexPattern}$`).test(filename)
  } catch {
    return false
  }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0) {
    writeAll(2, new TextEncoder().encode('find: missing path argument\n'))
    return 1
  }

  let startPaths = []
  let namePattern
  let fileType

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-name') {
      const next = args[++i]
      if (next !== undefined && !next.startsWith('-')) namePattern = next
      else { writeAll(2, new TextEncoder().encode('find: missing argument to -name\n')); return 1 }
    } else if (arg === '-type') {
      const next = args[++i]
      if (next !== undefined && !next.startsWith('-')) fileType = next
      else { writeAll(2, new TextEncoder().encode('find: missing argument to -type\n')); return 1 }
    } else if (!arg.startsWith('-')) {
      startPaths.push(arg)
    }
  }

  const cwd = getcwd()
  if (startPaths.length === 0) startPaths = [cwd]

  let output = ''

  function searchDirectory(dirPath) {
    let entries
    try {
      entries = readdir(dirPath)
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry)

      try {
        const isLink = isSymbolicLink(fullPath)
        const isDir = isDirectory(fullPath)

        let matches = true
        if (namePattern && !matchesPattern(entry, namePattern)) matches = false

        if (fileType && matches) {
          if (fileType === 'f' && (isDir || isLink)) matches = false
          else if (fileType === 'd' && !isDir) matches = false
          else if (fileType === 'l' && !isLink) matches = false
        }

        if (matches) output += fullPath + '\n'

        if (isDir && !isLink) searchDirectory(fullPath)
      } catch {
        // unreadable/racy entry -- skip, matching the original's silent catch
      }
    }
  }

  for (const startPath of startPaths) {
    const fullPath = resolve(cwd, startPath)
    try {
      if (!isDirectory(fullPath)) {
        writeAll(2, new TextEncoder().encode(`find: ${startPath}: not a directory\n`))
        continue
      }
      searchDirectory(fullPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeAll(2, new TextEncoder().encode(`find: ${startPath}: ${message}\n`))
    }
  }

  writeAll(1, new TextEncoder().encode(output))

  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`find: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
