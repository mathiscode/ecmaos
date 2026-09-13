/**
 * Real `execve`'d `mkdir` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/mkdir.ts`) per `feat/1.0.0-execve-commands`. `-p`/`--parents` is
 * userspace path-walking over the real single-level `mkdir` syscall, the same way real `mkdir -p`
 * is implemented in every libc -- `@zenfs/linux`'s `mkdir` syscall (`syscall/fs.js`) has no
 * recursive option, matching real `mkdir(2)`.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, mkdir, getcwd, stat } = globalThis.ecmaosSyscalls

const usage = `Usage: mkdir [OPTION]... DIRECTORY...
Create the DIRECTORY(ies), if they do not already exist.

  -p, --parents     no error if existing, make parent directories as needed
  -v, --verbose     print a message for each created directory
      --help        display this help and exit`

function parseNumericMode(mode) {
  if (/^0?[0-7]{1,4}$/.test(mode)) return parseInt(mode, 8)
  if (/^0o[0-7]{1,4}$/i.test(mode)) return parseInt(mode.slice(2), 8)
  return null
}

function exists(path) {
  try { stat(path); return true } catch { return false }
}

/** `mkdir -p`: create every missing segment from the root down, ignoring EEXIST along the way. */
function mkdirRecursive(path, mode) {
  const segments = path.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    if (exists(current)) continue
    try {
      mkdir(current, mode ?? 0o777)
    } catch (error) {
      if (!/EEXIST/.test(String(error?.message ?? error))) throw error
    }
  }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let parents = false
  let verbose = false
  let mode
  const directories = []

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--') { i++; directories.push(...args.slice(i)); break }
    if (arg === '--parents') parents = true
    else if (arg === '--verbose') verbose = true
    else if (arg.startsWith('--mode=')) {
      const parsed = parseNumericMode(arg.slice(7))
      if (parsed === null) { writeAll(2, new TextEncoder().encode(`mkdir: invalid mode '${arg.slice(7)}'\n`)); return 1 }
      mode = parsed
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]
        if (flag === 'p') parents = true
        else if (flag === 'v') verbose = true
        else { writeAll(2, new TextEncoder().encode(`mkdir: invalid option -- '${flag}'\n`)); return 1 }
      }
    } else {
      directories.push(arg)
    }
    i++
  }

  if (directories.length === 0) {
    writeAll(2, new TextEncoder().encode('mkdir: missing operand\n'))
    return 1
  }

  const cwd = getcwd()
  let hasError = false

  for (const target of directories) {
    const fullPath = resolve(cwd, target)
    try {
      const existedBefore = parents && exists(fullPath)
      if (parents) mkdirRecursive(fullPath, mode)
      else mkdir(fullPath, mode ?? 0o777)
      if (verbose && !existedBefore) writeAll(1, new TextEncoder().encode(`mkdir: created directory '${target}'\n`))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (parents && /EEXIST/.test(message)) continue
      writeAll(2, new TextEncoder().encode(`mkdir: ${target}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`mkdir: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
