/**
 * Real `execve`'d `zip` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/zip.ts`). Reads inputs and writes the archive over raw filesystem
 * syscalls; `@zip.js/zip.js` does the compression in memory (see `lib/zip-common.mjs`). The old
 * import-size limit that kept this library out of worker programs was a filesystem bug, not a real
 * limit (fixed in `filesystem.ts`), so the library bundles here like any other dependency. The
 * original's chalk coloring is dropped, as in the other migrated commands.
 */

import { resolve, join } from './lib/path-utils.mjs'
import { zip, out, err, readWholeFile, writeWholeFile, exists, relative, errorMessage, listZip } from './lib/zip-common.mjs'

const { argv, exit, getcwd, isDirectory, readdir } = globalThis.ecmaosSyscalls

const usage = `Usage: zip [OPTION]... ZIPFILE FILE...
Create a zip archive containing the specified files and directories.

  -r, --recurse    recurse into directories
  -l, --list       list contents of zip file
  -v, --verbose    verbose mode
  -h, --help       display this help and exit

Examples:
  zip archive.zip file1.txt file2.txt
  zip -r archive.zip directory/
  zip -l archive.zip`

function parseArgs(args) {
  const options = { recurse: false, list: false, verbose: false }
  const files = []
  let zipfile = null

  for (const arg of args) {
    if (!arg || arg === '--help' || arg === '-h') continue
    if (arg === '-r' || arg === '--recurse') options.recurse = true
    else if (arg === '-l' || arg === '--list') options.list = true
    else if (arg === '-v' || arg === '--verbose') options.verbose = true
    else if (arg.startsWith('-')) {
      for (const flag of arg.slice(1)) {
        if (flag === 'r') options.recurse = true
        else if (flag === 'l') options.list = true
        else if (flag === 'v') options.verbose = true
      }
    } else if (!zipfile) zipfile = arg
    else files.push(arg)
  }

  return { options, zipfile, files }
}

async function addDirectory(writer, dirPath, basePath, verbose) {
  for (const entry of readdir(dirPath)) {
    const entryPath = join(dirPath, entry)
    const relativePath = relative(basePath, entryPath)

    if (isDirectory(entryPath)) {
      await addDirectory(writer, entryPath, basePath, verbose)
    } else {
      await writer.add(relativePath, new zip.Uint8ArrayReader(readWholeFile(entryPath)))
      if (verbose) out(`  adding: ${relativePath}`)
    }
  }
}

async function main() {
  const args = argv.slice(1)

  if (args[0] === '--help' || args[0] === '-h') {
    err(usage)
    return 0
  }

  const cwd = getcwd()
  const { options, zipfile, files } = parseArgs(args)

  if (!zipfile) {
    err('zip error: zipfile name required')
    err("Try 'zip --help' for more information.")
    return 1
  }

  if (options.list) {
    const zipfilePath = resolve(cwd, zipfile)
    if (!exists(zipfilePath)) {
      err(`zip error: ${zipfile}: No such file or directory`)
      return 1
    }
    return await listZip(zipfilePath, 'zip')
  }

  if (files.length === 0) {
    err('zip error: nothing to do')
    err("Try 'zip --help' for more information.")
    return 1
  }

  const outputPath = resolve(cwd, zipfile)
  const writer = new zip.ZipWriter(new zip.BlobWriter())
  let hasError = false

  try {
    for (const inputPath of files) {
      const fullPath = resolve(cwd, inputPath)

      try {
        if (!exists(fullPath)) {
          err(`zip warning: ${inputPath}: No such file or directory`)
          hasError = true
          continue
        }

        if (isDirectory(fullPath)) {
          if (options.recurse) {
            await addDirectory(writer, fullPath, cwd, options.verbose)
            if (options.verbose) out(`  adding: ${relative(cwd, fullPath)}/`)
          } else {
            err(`zip warning: ${inputPath}: is a directory (not added). Use -r to recurse into directories`)
            hasError = true
          }
        } else {
          const relativePath = relative(cwd, fullPath)
          await writer.add(relativePath, new zip.Uint8ArrayReader(readWholeFile(fullPath)))
          if (options.verbose) out(`  adding: ${relativePath}`)
        }
      } catch (error) {
        err(`zip error: ${inputPath}: ${errorMessage(error)}`)
        hasError = true
      }
    }

    const blob = await writer.close()
    writeWholeFile(outputPath, new Uint8Array(await blob.arrayBuffer()))
    if (options.verbose) out(`  zipfile: ${zipfile}`)
    return hasError ? 1 : 0
  } catch (error) {
    err(`zip error: ${errorMessage(error)}`)
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`zip: ${errorMessage(error)}`)
  exit(1)
}
