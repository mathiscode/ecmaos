/**
 * Real `execve`'d `mktemp` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/mktemp.ts`) per `feat/1.0.0-execve-commands`. `crypto.getRandomValues` is
 * available inside a Web Worker by spec, unlike `window`/`document` -- no bridge needed. `env` (from
 * the real `init` message, `ecmaosSyscalls.env`) replaces `shell.env.get('TMPDIR')`.
 */

import { resolve, join } from './lib/path-utils.mjs'

const { argv, exit, write, getcwd, env, mkdir, stat, O_WRONLY, O_CREAT, open, close } = globalThis.ecmaosSyscalls

function exists(path) {
  try { stat(path); return true } catch { return false }
}

/** `mkdir -p`-equivalent: create every missing segment from the root down (`@zenfs/linux`'s `mkdir`
 * syscall has no recursive option, matching real `mkdir(2)`), ignoring EEXIST along the way -- the
 * same approach `mkdir.mjs`'s own `mkdirRecursive` uses. */
function mkdirRecursive(path, mode) {
  const segments = path.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    if (exists(current)) continue
    try {
      mkdir(current, mode ?? 0o755)
    } catch (error) {
      if (!/EEXIST/.test(String(error?.message ?? error))) throw error
    }
  }
}

const usage = `Usage: mktemp [OPTION]... [TEMPLATE]
Create a temporary file or directory, safely, and print its name.

  -d, --directory     create a directory, not a file
  -q, --quiet        suppress error messages
  -u, --dry-run      do not create anything; merely print a name (unsafe)
  -p DIR, --tmpdir=DIR  interpret TEMPLATE relative to DIR; if DIR is not
                        specified, use \$TMPDIR if set, else /tmp.
  -t                 interpret TEMPLATE relative to the directory specified by
                        -p, or \$TMPDIR if -p is not given; if neither is
                        specified, use /tmp [deprecated]
  --help             display this help and exit

The TEMPLATE must contain at least 3 consecutive 'X's in last component.
If TEMPLATE is not specified, use tmp.XXXXXX, and --tmpdir implies -t.`

function basename(p) {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

function dirname(p) {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx === -1) return '.'
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

function generateRandomChars(count) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let result = ''
  const randomValues = crypto.getRandomValues(new Uint8Array(count))
  for (let i = 0; i < count; i++) result += chars[randomValues[i] % chars.length]
  return result
}

function replaceTemplate(template) {
  const xCount = (template.match(/X/g) || []).length
  if (xCount === 0) return template + '.' + generateRandomChars(6)

  let result = template
  const randomChars = generateRandomChars(xCount)
  let charIndex = 0

  for (let i = 0; i < template.length; i++) {
    if (template[i] === 'X') {
      result = result.substring(0, i) + randomChars[charIndex] + result.substring(i + 1)
      charIndex++
    }
  }

  return result
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let createDirectory = false
  let quiet = false
  let dryRun = false
  let tmpdir
  let useTmpdir = false
  let template

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-d' || arg === '--directory') createDirectory = true
    else if (arg === '-q' || arg === '--quiet') quiet = true
    else if (arg === '-u' || arg === '--dry-run') dryRun = true
    else if (arg === '-t') useTmpdir = true
    else if (arg === '-p' || arg === '--tmpdir') {
      useTmpdir = true
      const dirArg = args[i + 1]
      if (dirArg && !dirArg.startsWith('-')) { tmpdir = dirArg; i++ }
    } else if (arg.startsWith('--tmpdir=')) {
      useTmpdir = true
      const dirValue = arg.split('=')[1]
      if (dirValue) tmpdir = dirValue
    } else if (!arg.startsWith('-')) {
      if (!template) template = arg
      else { if (!quiet) write(2, new TextEncoder().encode('mktemp: too many arguments\n')); return 1 }
    } else {
      if (!quiet) {
        write(2, new TextEncoder().encode(`mktemp: invalid option -- '${arg.replace(/^-+/, '')}'\n`))
        write(2, new TextEncoder().encode("Try 'mktemp --help' for more information.\n"))
      }
      return 1
    }
  }

  let baseDir = '/tmp'
  if (useTmpdir) {
    if (tmpdir) baseDir = tmpdir
    else if (env.TMPDIR) baseDir = env.TMPDIR
  }

  const cwd = getcwd()
  const resolvedBaseDir = baseDir.startsWith('/') ? baseDir : resolve(cwd, baseDir)

  if (!template) template = 'tmp.XXXXXX'

  if (useTmpdir && template.startsWith('/')) {
    if (!quiet) write(2, new TextEncoder().encode('mktemp: with -p/--tmpdir, TEMPLATE must not be an absolute name\n'))
    return 1
  }

  const fullPath = template.startsWith('/') ? template : join(resolvedBaseDir, template)

  const base = basename(fullPath)
  const xCount = (base.match(/X/g) || []).length
  if (xCount < 3) {
    if (!quiet) write(2, new TextEncoder().encode(`mktemp: too few X's in template ${template}\n`))
    return 1
  }

  const finalPath = replaceTemplate(fullPath)

  if (dryRun) {
    write(1, new TextEncoder().encode(finalPath + '\n'))
    return 0
  }

  try {
    if (createDirectory) {
      mkdirRecursive(finalPath)
    } else {
      try { mkdirRecursive(dirname(finalPath)) } catch { /* parent might already exist */ }
      const fd = open(finalPath, O_WRONLY | O_CREAT, 0o644)
      close(fd)
    }

    write(1, new TextEncoder().encode(finalPath + '\n'))
    return 0
  } catch (error) {
    if (!quiet) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`mktemp: ${message}\n`))
    }
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`mktemp: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
