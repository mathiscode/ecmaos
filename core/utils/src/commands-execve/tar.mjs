/**
 * Real `execve`'d `tar` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/tar.ts`) per `feat/1.0.0-execve-commands`. The original streamed
 * entries one at a time through `modern-tar`'s `createTarPacker`/`createTarDecoder` (`ReadableStream`/
 * `WritableStream`/`TransformStream`, piped to/from real file handles). This port uses
 * `modern-tar`'s other, buffered API instead -- `packTar(entries): Promise<Uint8Array>` and
 * `unpackTar(bytes): Promise<ParsedTarEntryWithData[]>` -- whole-archive-in-memory, the same way
 * every other migrated coreutil already reads/writes whole files via `readWholeFile`/
 * `writeWholeFile` helpers. Confirmed the whole library (buffered API included) bundles to only
 * ~13KB minified, nowhere near the ~345KB that broke `stat.mjs`'s original `@zip.js/zip.js` import,
 * so there's no bundle-size risk here -- the buffered API was chosen instead of the streaming one to
 * avoid this migration's first untested reliance on `WritableStream.getWriter()`/`TransformStream`
 * inside a worker program, for a payoff (lower peak memory on huge archives) this OS doesn't need
 * yet. `-z` gzip is still supported: `CompressionStream`/`DecompressionStream` are standard Worker
 * globals, not part of `modern-tar` itself, so wrapping the buffered bytes through them adds no
 * bundle risk. See `cat.mjs`'s doc comment for why there's no in-band interrupt handling anymore.
 */

import { resolve, join, dirname } from './lib/path-utils.mjs'
import { packTar, unpackTar } from 'modern-tar'

const { argv, exit, writeAll, read, getcwd, open, close, stat, isDirectory, readdir, mkdir, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: tar [OPTION]... [FILE]...
Create, extract, or list tar archives.

  -c, --create    create a new archive
  -x, --extract   extract files from an archive
  -t, --list      list the contents of an archive
  -f, --file      use archive file (required for create, optional for extract/list - uses stdin if omitted)
  -z              filter the archive through gzip
  -v, --verbose   verbosely list files processed
  -C, --directory change to directory before extracting
  -h, --help      display this help and exit`

function readWholeFile(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return bytes
}

function writeWholeFile(fullPath, bytes) {
  const fd = open(fullPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    writeAll(fd, bytes)
  } finally {
    close(fd)
  }
}

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function gzipCompress(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gzipDecompress(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function parseArgs(args) {
  const options = { create: false, extract: false, list: false, file: null, gzip: false, verbose: false, directory: null }
  const files = []
  let i = 0

  while (i < args.length) {
    const arg = args[i]
    if (!arg) { i++; continue }

    if (arg === '--help' || arg === '-h') { i++; continue }
    else if (arg === '-c' || arg === '--create') { options.create = true; i++ }
    else if (arg === '-x' || arg === '--extract') { options.extract = true; i++ }
    else if (arg === '-t' || arg === '--list') { options.list = true; i++ }
    else if (arg === '-f' || arg === '--file') {
      if (i + 1 < args.length) { i++; options.file = args[i] || null } else { options.file = null }
      i++
    } else if (arg === '-z') { options.gzip = true; i++ }
    else if (arg === '-v' || arg === '--verbose') { options.verbose = true; i++ }
    else if (arg === '-C' || arg === '--directory') {
      if (i + 1 < args.length) { i++; options.directory = args[i] || null } else { options.directory = null }
      i++
    } else if (arg.startsWith('-')) {
      const flagString = arg.slice(1)
      let flagIndex = 0
      while (flagIndex < flagString.length) {
        const flag = flagString[flagIndex]
        if (flag === 'c') { options.create = true; flagIndex++ }
        else if (flag === 'x') { options.extract = true; flagIndex++ }
        else if (flag === 't') { options.list = true; flagIndex++ }
        else if (flag === 'f') {
          const remaining = flagString.slice(flagIndex + 1)
          if (remaining.length > 0 && !remaining.startsWith('-')) {
            options.file = remaining
            flagIndex = flagString.length
          } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
            i++
            options.file = args[i]
            flagIndex++
          } else {
            flagIndex++
          }
        } else if (flag === 'z') { options.gzip = true; flagIndex++ }
        else if (flag === 'v') { options.verbose = true; flagIndex++ }
        else if (flag === 'C') {
          const remaining = flagString.slice(flagIndex + 1)
          if (remaining.length > 0 && !remaining.startsWith('-')) {
            options.directory = remaining
            flagIndex = flagString.length
          } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
            i++
            options.directory = args[i]
            flagIndex++
          } else {
            flagIndex++
          }
        } else {
          flagIndex++
        }
      }
      i++
    } else {
      files.push(arg)
      i++
    }
  }

  return { options, files }
}

function collectFiles(cwd, filePaths, basePath = '') {
  const result = []
  for (const filePath of filePaths) {
    const fullPath = resolve(cwd, filePath)
    try {
      if (isDirectory(fullPath)) {
        const relativePath = join(basePath, filePath)
        result.push({ path: relativePath.endsWith('/') ? relativePath : relativePath + '/', fullPath, isDirectory: true })
        const entries = readdir(fullPath)
        // Recurse using each entry's bare name, not an absolute path -- collectFiles resolves
        // filePaths against cwd itself, so passing an already-absolute subFiles entry back through
        // would double up (cwd + absolute path), producing a garbled archive entry name.
        const subResults = collectFiles(fullPath, entries, join(basePath, filePath))
        result.push(...subResults)
      } else {
        result.push({ path: join(basePath, filePath), fullPath, isDirectory: false })
      }
    } catch {
      continue
    }
  }
  return result
}

async function createArchive(cwd, archivePath, filePaths, options) {
  if (filePaths.length === 0) {
    writeAll(2, new TextEncoder().encode('tar: no files specified\n'))
    return 1
  }

  try {
    const fullArchivePath = resolve(cwd, archivePath)
    const filesToArchive = collectFiles(cwd, filePaths)

    if (filesToArchive.length === 0) {
      writeAll(2, new TextEncoder().encode('tar: no files to archive\n'))
      return 1
    }

    const entries = []
    for (const file of filesToArchive) {
      if (file.isDirectory) {
        const dirName = file.path.endsWith('/') ? file.path : file.path + '/'
        entries.push({ header: { name: dirName, type: 'directory', size: 0 } })
        if (options.verbose) writeAll(1, new TextEncoder().encode(dirName + '\n'))
      } else {
        try {
          const content = readWholeFile(file.fullPath)
          entries.push({ header: { name: file.path, type: 'file', size: content.length }, body: content })
          if (options.verbose) writeAll(1, new TextEncoder().encode(file.path + '\n'))
        } catch (error) {
          writeAll(2, new TextEncoder().encode(`tar: ${file.path}: ${error instanceof Error ? error.message : String(error)}\n`))
        }
      }
    }

    let archiveBytes = await packTar(entries)
    if (options.gzip) archiveBytes = await gzipCompress(archiveBytes)

    writeWholeFile(fullArchivePath, archiveBytes)
    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`tar: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function readArchiveBytes(cwd, archivePath, options) {
  let bytes
  if (archivePath) {
    const fullArchivePath = resolve(cwd, archivePath)
    try {
      stat(fullArchivePath)
    } catch {
      writeAll(2, new TextEncoder().encode(`tar: ${archivePath}: Cannot open: No such file or directory\n`))
      return null
    }
    bytes = readWholeFile(fullArchivePath)
  } else {
    bytes = readAllStdin()
  }

  if (options.gzip) bytes = await gzipDecompress(bytes)
  return bytes
}

async function extractArchive(cwd, archivePath, options) {
  try {
    const bytes = await readArchiveBytes(cwd, archivePath, options)
    if (bytes === null) return 1

    const entries = await unpackTar(bytes)
    let hasError = false
    const extractBase = options.directory ? resolve(cwd, options.directory) : cwd

    for (const entry of entries) {
      if (options.verbose) writeAll(1, new TextEncoder().encode(entry.header.name + '\n'))

      try {
        let entryName = entry.header.name
        while (entryName.startsWith('/')) entryName = entryName.slice(1)
        if (!entryName) continue

        const targetPath = resolve(extractBase, entryName)
        const resolvedBase = resolve(extractBase, '.')
        if (!targetPath.startsWith(resolvedBase + '/') && targetPath !== resolvedBase) {
          writeAll(2, new TextEncoder().encode(`tar: ${entry.header.name}: path outside extraction directory\n`))
          hasError = true
          continue
        }

        if (entry.header.type === 'directory' || entry.header.name.endsWith('/')) {
          try { mkdir(targetPath, 0o755) } catch { /* may already exist */ }
        } else if (entry.header.type === 'file') {
          const dirPath = dirname(targetPath)
          try { mkdir(dirPath, 0o755) } catch { /* may already exist */ }
          writeWholeFile(targetPath, entry.data || new Uint8Array(0))
        }
      } catch (error) {
        writeAll(2, new TextEncoder().encode(`tar: ${entry.header.name}: ${error instanceof Error ? error.message : String(error)}\n`))
        hasError = true
      }
    }

    return hasError ? 1 : 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`tar: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function listArchive(cwd, archivePath, options) {
  try {
    const bytes = await readArchiveBytes(cwd, archivePath, options)
    if (bytes === null) return 1

    const entries = await unpackTar(bytes)
    let output = ''
    for (const entry of entries) output += entry.header.name + '\n'
    writeAll(1, new TextEncoder().encode(output))

    return 0
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`tar: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const { options, files } = parseArgs(args)

  const operationCount = [options.create, options.extract, options.list].filter(Boolean).length
  if (operationCount === 0) {
    writeAll(2, new TextEncoder().encode("tar: You must specify one of the -c, -x, or -t options\nTry 'tar --help' for more information.\n"))
    return 1
  }
  if (operationCount > 1) {
    writeAll(2, new TextEncoder().encode('tar: You may not specify more than one of -c, -x, or -t\n'))
    return 1
  }
  if (options.create && !options.file) {
    writeAll(2, new TextEncoder().encode("tar: option requires an argument -- f\nTry 'tar --help' for more information.\n"))
    return 1
  }

  const cwd = getcwd()

  const expandGlob = (pattern) => {
    if (!pattern.includes('*') && !pattern.includes('?')) return [pattern]

    const lastSlashIndex = pattern.lastIndexOf('/')
    const searchDir = lastSlashIndex !== -1 ? resolve(cwd, pattern.substring(0, lastSlashIndex + 1)) : cwd
    const globPattern = lastSlashIndex !== -1 ? pattern.substring(lastSlashIndex + 1) : pattern

    try {
      const entries = readdir(searchDir)
      const regexPattern = globPattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')
      const regex = new RegExp(`^${regexPattern}$`)
      const matches = entries.filter(entry => regex.test(entry))
      if (lastSlashIndex !== -1) {
        const dirPart = pattern.substring(0, lastSlashIndex + 1)
        return matches.map(match => dirPart + match)
      }
      return matches
    } catch {
      return []
    }
  }

  const expandedFiles = []
  for (const filePattern of files) {
    const expanded = expandGlob(filePattern)
    if (expanded.length === 0) expandedFiles.push(filePattern)
    else expandedFiles.push(...expanded)
  }

  if (options.create) {
    return await createArchive(cwd, options.file, expandedFiles, options)
  } else if (options.extract) {
    return await extractArchive(cwd, options.file, options)
  } else if (options.list) {
    return await listArchive(cwd, options.file, options)
  }

  return 1
}

try {
  exit(await main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`tar: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
