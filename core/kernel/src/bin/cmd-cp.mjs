/**
 * Real `execve`'d `cp` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/cp.ts`) per `feat/1.0.0-execve-commands`. Recursive directory copy is
 * userspace (`readdir` + recurse), same as every real `cp -r`; there is no recursive-copy syscall.
 */

import { resolve, join, basename } from './lib/path-utils.mjs'

const { argv, exit, write, getcwd, stat, isDirectory, readdir, mkdir, copyFile } = globalThis.ecmaosSyscalls

const usage = `Usage: cp [OPTION]... SOURCE... DEST
Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.

  -r, -R, --recursive   copy directories recursively
  -v, --verbose         explain what is being done
  --help                display this help and exit`

function exists(path) {
  try { stat(path); return true } catch { return false }
}

function copyRecursive(sourcePath, destPath, verbose, relativeSource, relativeDest) {
  if (isDirectory(sourcePath)) {
    if (!exists(destPath)) {
      mkdir(destPath, 0o777)
      if (verbose) write(1, new TextEncoder().encode(`'${relativeSource}' -> '${relativeDest}'\n`))
    }
    for (const entry of readdir(sourcePath)) {
      copyRecursive(join(sourcePath, entry), join(destPath, entry), verbose, join(relativeSource, entry), join(relativeDest, entry))
    }
  } else {
    copyFile(sourcePath, destPath)
    if (verbose) write(1, new TextEncoder().encode(`'${relativeSource}' -> '${relativeDest}'\n`))
  }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let recursive = false
  let verbose = false
  const paths = []

  for (const arg of args) {
    if (arg.startsWith('-') && arg !== '--') {
      if (arg === '--recursive') recursive = true
      else if (arg === '--verbose') verbose = true
      else {
        for (let i = 1; i < arg.length; i++) {
          const flag = arg[i]
          if (flag === 'r' || flag === 'R') recursive = true
          else if (flag === 'v') verbose = true
          else { write(2, new TextEncoder().encode(`cp: invalid option -- '${flag}'\n`)); return 1 }
        }
      }
    } else if (arg && !arg.startsWith('-')) {
      paths.push(arg)
    }
  }

  if (paths.length < 2) {
    write(2, new TextEncoder().encode("cp: missing file operand\nTry 'cp --help' for more information.\n"))
    return 1
  }

  const sources = paths.slice(0, -1)
  const destination = paths[paths.length - 1]
  const cwd = getcwd()

  let hasError = false
  try {
    const destPath = resolve(cwd, destination)
    const isDestDir = exists(destPath) && isDirectory(destPath)

    if (sources.length > 1 && !isDestDir) {
      write(2, new TextEncoder().encode(`cp: target '${destination}' is not a directory\n`))
      return 1
    }

    for (const source of sources) {
      const sourcePath = resolve(cwd, source)
      const finalDest = isDestDir ? join(destPath, basename(source)) : destPath

      try {
        if (isDirectory(sourcePath)) {
          if (!recursive) {
            write(2, new TextEncoder().encode(`cp: -r not specified; omitting directory '${source}'\n`))
            hasError = true
            continue
          }
          const relativeDest = isDestDir ? join(destination, basename(source)) : destination
          copyRecursive(sourcePath, finalDest, verbose, source, relativeDest)
        } else {
          copyFile(sourcePath, finalDest)
          if (verbose) {
            const relativeDest = isDestDir ? join(destination, basename(source)) : destination
            write(1, new TextEncoder().encode(`'${source}' -> '${relativeDest}'\n`))
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        write(2, new TextEncoder().encode(`cp: ${source}: ${message}\n`))
        hasError = true
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(2, new TextEncoder().encode(`cp: ${message}\n`))
    hasError = true
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`cp: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
