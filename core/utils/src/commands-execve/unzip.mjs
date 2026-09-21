/**
 * Real `execve`'d `unzip` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/unzip.ts`). See `zip.mjs` and `lib/zip-common.mjs` for the shared
 * `@zip.js/zip.js` setup. Behavior is unchanged apart from dropping the original's chalk coloring:
 * glob fallback for unmatched zipfile arguments, `-d`, `-o`, `-q`, `-v`, `-x`, member selection, and
 * the directory-traversal guard.
 */

import { resolve, dirname, basename } from './lib/path-utils.mjs'
import { zip, out, err, readWholeFile, writeWholeFile, mkdirRecursive, exists, errorMessage, listZip } from './lib/zip-common.mjs'

const { argv, exit, getcwd, isDirectory, readdir } = globalThis.ecmaosSyscalls

const usage = `Usage: unzip [OPTION]... ZIPFILE [FILE]...
Extract files from a zip archive.

  -l, --list       list contents of zip file
  -d, --directory  extract files to directory
  -o, --overwrite  overwrite files without prompting
  -q, --quiet      quiet mode (suppress output)
  -v, --verbose    verbose mode
  -x, --exclude    exclude files from extraction
  -h, --help       display this help and exit

Examples:
  unzip archive.zip
  unzip -d /tmp archive.zip
  unzip -l archive.zip
  unzip -x "*.txt" archive.zip`

function parseArgs(args) {
  const options = { list: false, directory: null, overwrite: false, quiet: false, verbose: false, exclude: [] }
  const files = []
  let zipfile = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg || arg === '--help' || arg === '-h') continue
    if (arg === '-l' || arg === '--list') options.list = true
    else if (arg === '-d' || arg === '--directory') {
      if (i + 1 < args.length) options.directory = args[++i] || null
    } else if (arg === '-o' || arg === '--overwrite') options.overwrite = true
    else if (arg === '-q' || arg === '--quiet') options.quiet = true
    else if (arg === '-v' || arg === '--verbose') options.verbose = true
    else if (arg === '-x' || arg === '--exclude') {
      if (i + 1 < args.length && args[i + 1]) options.exclude.push(args[i + 1])
      i++
    } else if (arg.startsWith('-')) {
      for (const flag of arg.slice(1)) {
        if (flag === 'l') options.list = true
        else if (flag === 'o') options.overwrite = true
        else if (flag === 'q') options.quiet = true
        else if (flag === 'v') options.verbose = true
      }
    } else if (!zipfile) zipfile = arg
    else files.push(arg)
  }

  return { options, zipfile, files }
}

const globToRegExp = pattern => new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)

function expandGlob(pattern, cwd) {
  if (!pattern.includes('*') && !pattern.includes('?')) return [pattern]

  const slash = pattern.lastIndexOf('/')
  const searchDir = slash !== -1 ? resolve(cwd, pattern.substring(0, slash + 1)) : cwd
  const regex = globToRegExp(slash !== -1 ? pattern.substring(slash + 1) : pattern)

  try {
    const matches = readdir(searchDir).filter(entry => regex.test(entry))
    return slash !== -1 ? matches.map(match => pattern.substring(0, slash + 1) + match) : matches
  } catch {
    return []
  }
}

async function extractFromZip(zipfilePath, options, extractPath, files) {
  const reader = new zip.ZipReader(new zip.BlobReader(new Blob([readWholeFile(zipfilePath)])))
  const entries = await reader.getEntries()

  let extractedCount = 0
  let skippedCount = 0
  let hasError = false

  const entriesToExtract = files.length > 0
    ? entries.filter(entry => files.some(file => entry.filename === file || entry.filename.startsWith(file + '/')))
    : entries

  for (const entry of entriesToExtract) {
    const entryName = entry.filename.replace(/^\/+/, '')
    if (!entryName) continue

    if (options.exclude.some(pattern => globToRegExp(pattern).test(entry.filename))) {
      if (options.verbose && !options.quiet) out(`  skipping: ${entryName}`)
      skippedCount++
      continue
    }

    const entryPath = resolve(extractPath, entryName)
    const base = resolve(extractPath, '.')
    if (entryPath !== base && !entryPath.startsWith(base === '/' ? '/' : base + '/')) {
      err(`unzip error: ${entry.filename}: path outside extraction directory`)
      hasError = true
      continue
    }

    try {
      if (exists(entryPath) && !options.overwrite) {
        if (!options.quiet) err(`unzip: ${entryName} already exists - skipping (use -o to overwrite)`)
        skippedCount++
        continue
      }

      mkdirRecursive(dirname(entryPath))

      if (entry.directory || entryName.endsWith('/')) {
        mkdirRecursive(entryPath)
        if (options.verbose && !options.quiet) out(`  creating: ${entryName}/`)
      } else {
        const data = await entry.getData?.(new zip.Uint8ArrayWriter())
        if (!data) {
          err(`unzip error: Failed to read ${entryName}`)
          hasError = true
          continue
        }
        writeWholeFile(entryPath, data)
        if (!options.quiet) out(`  inflating: ${entryName}`)
      }
      extractedCount++
    } catch (error) {
      err(`unzip error: ${entryName}: ${errorMessage(error)}`)
      hasError = true
    }
  }

  await reader.close()
  return { extractedCount, skippedCount, hasError }
}

/**
 * The shell expands globs that match; one that doesn't is passed through verbatim, so expand it
 * here. A shell-expanded `*.zip` also lands as zipfile plus "files", hence the `.zip` suffix rule:
 * such arguments are more archives, anything else is a member to extract.
 */
function collectZipfiles(zipfile, files, cwd) {
  const zipfiles = []
  const members = []
  let hasError = false

  const addArchive = (name, fatal) => {
    if (exists(resolve(cwd, name))) { zipfiles.push(name); return true }
    const expanded = name.includes('*') || name.includes('?') ? expandGlob(name, cwd) : []
    if (expanded.length > 0) { zipfiles.push(...expanded); return true }
    err(`unzip error: ${name}: No such file or directory`)
    if (fatal) hasError = true
    return false
  }

  if (!addArchive(zipfile, true)) return { zipfiles, members, hasError: true }
  for (const file of files) {
    if (file.toLowerCase().endsWith('.zip')) addArchive(file, false)
    else members.push(file)
  }

  return { zipfiles, members, hasError }
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
    err('unzip error: zipfile name required')
    err("Try 'unzip --help' for more information.")
    return 1
  }

  const { zipfiles, members, hasError: setupFailed } = collectZipfiles(zipfile, files, cwd)
  if (setupFailed) return 1

  if (zipfiles.length === 0) {
    err('unzip error: No zip files to process')
    return 1
  }

  if (options.list) return await listZip(resolve(cwd, zipfiles[0]), 'unzip')

  const extractPath = options.directory ? resolve(cwd, options.directory) : cwd

  try {
    if (!exists(extractPath)) mkdirRecursive(extractPath)
    else if (!isDirectory(extractPath)) {
      err(`unzip error: ${options.directory}: Not a directory`)
      return 1
    }
  } catch (error) {
    err(`unzip error: Cannot create directory ${extractPath}: ${errorMessage(error)}`)
    return 1
  }

  let hasError = false

  for (const item of zipfiles) {
    const zipfilePath = resolve(cwd, item)
    if (!exists(zipfilePath)) {
      err(`unzip error: ${item}: No such file or directory`)
      hasError = true
      continue
    }

    try {
      const result = await extractFromZip(zipfilePath, options, extractPath, members)
      if (result.hasError) hasError = true

      if (!options.quiet) {
        out(`\nArchive:  ${basename(zipfilePath)}`)
        out(`  ${result.extractedCount} file${result.extractedCount !== 1 ? 's' : ''} extracted`)
        if (result.skippedCount > 0) out(`  ${result.skippedCount} file${result.skippedCount !== 1 ? 's' : ''} skipped`)
      }
    } catch (error) {
      err(`unzip error: ${item}: ${errorMessage(error)}`)
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  err(`unzip: ${errorMessage(error)}`)
  exit(1)
}
