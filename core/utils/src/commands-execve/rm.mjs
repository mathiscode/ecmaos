/**
 * Real `execve`'d `rm` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/rm.ts`) per `feat/1.0.0-execve-commands`. Glob expansion and recursive
 * removal are userspace (`readdir`/`rmRecursive`, both from `/bin/node`'s own helpers), the same as
 * every real `rm` implementation -- there is no recursive-remove or glob syscall in real Linux either.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, stat, unlink, rmdir, readdir, isDirectory, rmRecursive } = globalThis.ecmaosSyscalls

const usage = `Usage: rm [OPTION]... FILE...
Remove (unlink) the FILE(s).

  -f, --force     ignore nonexistent files and arguments, never prompt
  -r, -R, --recursive   remove directories and their contents recursively
  --help          display this help and exit`

function expandGlob(cwd, pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) return [pattern]

  const lastSlash = pattern.lastIndexOf('/')
  const searchDir = lastSlash !== -1 ? resolve(cwd, pattern.slice(0, lastSlash + 1)) : cwd
  const globPattern = lastSlash !== -1 ? pattern.slice(lastSlash + 1) : pattern
  const dirPrefix = lastSlash !== -1 ? pattern.slice(0, lastSlash + 1) : ''

  try {
    const entries = readdir(searchDir)
    const regex = new RegExp(`^${globPattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    const matches = entries.filter(name => regex.test(name))
    return matches.length ? matches.map(name => dirPrefix + name) : []
  } catch {
    return []
  }
}

function main() {
  const args = argv.slice(1)
  if (args.length === 0) {
    writeAll(2, new TextEncoder().encode("rm: missing operand\nTry 'rm --help' for more information.\n"))
    return 1
  }
  if (args[0] === '--help' || args[0] === '-h') {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let recursive = false
  let force = false
  const patterns = []

  for (const arg of args) {
    if (arg.startsWith('-') && arg !== '--') {
      if (arg === '--recursive' || arg === '-R') recursive = true
      else if (arg === '--force') force = true
      else if (arg.length > 1) {
        for (let i = 1; i < arg.length; i++) {
          const flag = arg[i]
          if (flag === 'r' || flag === 'R') recursive = true
          else if (flag === 'f') force = true
          else { writeAll(2, new TextEncoder().encode(`rm: invalid option -- '${flag}'\n`)); return 1 }
        }
      } else {
        writeAll(2, new TextEncoder().encode(`rm: invalid option -- '${arg.slice(1)}'\n`))
        return 1
      }
    } else {
      patterns.push(arg)
    }
  }

  if (patterns.length === 0) {
    writeAll(2, new TextEncoder().encode('rm: missing operand\n'))
    return 1
  }

  const cwd = getcwd()
  const expanded = []
  for (const pattern of patterns) {
    const matches = expandGlob(cwd, pattern)
    expanded.push(...(matches.length ? matches : [pattern]))
  }

  let hasError = false
  for (const target of expanded) {
    const fullPath = resolve(cwd, target)
    try {
      let isDir = false
      try { isDir = isDirectory(fullPath) } catch (statError) {
        if (!force) {
          writeAll(2, new TextEncoder().encode(`rm: ${target}: No such file or directory\n`))
          hasError = true
        }
        continue
      }
      if (isDir && !recursive) {
        writeAll(2, new TextEncoder().encode(`rm: ${target}: is a directory\n`))
        hasError = true
        continue
      }
      if (isDir) rmRecursive(fullPath)
      else unlink(fullPath)
    } catch (error) {
      if (!force) {
        const message = error instanceof Error ? error.message : String(error)
        writeAll(2, new TextEncoder().encode(`rm: ${target}: ${message}\n`))
        hasError = true
      }
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`rm: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
