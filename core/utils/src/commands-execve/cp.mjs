/**
 * Copy files and directories. `-r`/`-R` copies directories recursively. A new file or directory gets its
 * source's permission bits (without setuid, setgid or sticky); an existing destination keeps its own mode.
 * `-p` also keeps those special bits, the access and modification times, and the owner (the owner only when
 * the caller may chown).
 */

import { resolve, join, basename } from './lib/path-utils.mjs'
import { chmodOwned, chownOwned } from './lib/owner-ops.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat, isDirectory, readdir, mkdir, utimes, copyFile } = sys

const usage = `Usage: cp [OPTION]... SOURCE... DEST
Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.

  -r, -R, --recursive   copy directories recursively
  -p, --preserve        keep the mode (setuid and sticky bits too), the times and, for root, the owner
  -v, --verbose         explain what is being done
  --help                display this help and exit`

function exists(path) {
  try { stat(path); return true } catch { return false }
}

/** Keeps what `-p` asks for: the whole mode, and the owner when this caller is allowed to give it. */
async function preserve(stats, destPath) {
  // the owner first: changing it clears the setuid and setgid bits, which the mode then puts back
  try { await chownOwned(sys, destPath, stats.uid, stats.gid) } catch { /* only root may give a file away */ }
  await chmodOwned(sys, destPath, stats.mode & 0o7777)
  // last, since writing into a directory changes its times
  // seconds, as Node's `utimes` takes them (the upstream wrapper's comment says milliseconds; it is not)
  try { utimes(destPath, stats.atimeMs / 1000, stats.mtimeMs / 1000) } catch (error) { if (!isDirectory(destPath)) throw error }
}

async function copyOne(sourcePath, destPath, keep) {
  // taken before the source is read, which is what changes its access time
  const stats = stat(sourcePath)
  // the mode only matters for a file that does not exist yet; an older @zenfs/core also checks it as access to one that does
  copyFile(sourcePath, destPath, exists(destPath) ? 0o644 : stats.mode & 0o777)
  if (keep) await preserve(stats, destPath)
}

async function copyRecursive(sourcePath, destPath, verbose, relativeSource, relativeDest, keep) {
  if (isDirectory(sourcePath)) {
    const stats = stat(sourcePath)
    const mode = stats.mode & 0o777
    const created = !exists(destPath)
    if (created) {
      // owner rwx while the contents go in, so a read-only source directory can still be filled
      mkdir(destPath, mode | 0o700)
      if (verbose) writeAll(1, new TextEncoder().encode(`'${relativeSource}' -> '${relativeDest}'\n`))
    }
    for (const entry of readdir(sourcePath)) {
      await copyRecursive(join(sourcePath, entry), join(destPath, entry), verbose, join(relativeSource, entry), join(relativeDest, entry), keep)
    }
    if (keep) await preserve(stats, destPath)
    else if (created && (mode | 0o700) !== mode) await chmodOwned(sys, destPath, mode)
  } else {
    await copyOne(sourcePath, destPath, keep)
    if (verbose) writeAll(1, new TextEncoder().encode(`'${relativeSource}' -> '${relativeDest}'\n`))
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
  let keep = false
  const paths = []

  for (const arg of args) {
    if (arg.startsWith('-') && arg !== '--') {
      if (arg === '--recursive') recursive = true
      else if (arg === '--verbose') verbose = true
      else if (arg === '--preserve') keep = true
      else {
        for (let i = 1; i < arg.length; i++) {
          const flag = arg[i]
          if (flag === 'r' || flag === 'R') recursive = true
          else if (flag === 'v') verbose = true
          else if (flag === 'p') keep = true
          else { writeAll(2, new TextEncoder().encode(`cp: invalid option -- '${flag}'\n`)); return 1 }
        }
      }
    } else if (arg && !arg.startsWith('-')) {
      paths.push(arg)
    }
  }

  if (paths.length < 2) {
    writeAll(2, new TextEncoder().encode("cp: missing file operand\nTry 'cp --help' for more information.\n"))
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
      writeAll(2, new TextEncoder().encode(`cp: target '${destination}' is not a directory\n`))
      return 1
    }

    for (const source of sources) {
      const sourcePath = resolve(cwd, source)
      const finalDest = isDestDir ? join(destPath, basename(source)) : destPath

      try {
        if (isDirectory(sourcePath)) {
          if (!recursive) {
            writeAll(2, new TextEncoder().encode(`cp: -r not specified; omitting directory '${source}'\n`))
            hasError = true
            continue
          }
          const relativeDest = isDestDir ? join(destination, basename(source)) : destination
          await copyRecursive(sourcePath, finalDest, verbose, source, relativeDest, keep)
        } else {
          await copyOne(sourcePath, finalDest, keep)
          if (verbose) {
            const relativeDest = isDestDir ? join(destination, basename(source)) : destination
            writeAll(1, new TextEncoder().encode(`'${source}' -> '${relativeDest}'\n`))
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeAll(2, new TextEncoder().encode(`cp: ${source}: ${message}\n`))
        hasError = true
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeAll(2, new TextEncoder().encode(`cp: ${message}\n`))
    hasError = true
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`cp: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
