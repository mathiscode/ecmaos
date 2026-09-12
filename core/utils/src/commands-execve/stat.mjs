/**
 * Real `execve`'d `stat` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/stat.ts`) per `feat/1.0.0-execve-commands`. The original used
 * `@zip.js/zip.js` for its `.zip`-entries listing; bundled in here, that ~345KB library pushed this
 * program's `data:` URL past some real, empirically-confirmed size limit on importing a worker
 * program this large (a minimal repro without the ZIP codepath imports fine; the full bundle throws
 * a bare `SyntaxError` on import, no useful message) -- so this hand-parses the real ZIP central
 * directory instead (a plain, well-documented binary format: an End-Of-Central-Directory record at
 * the end of the file points at where the central directory starts, and each fixed 46-byte record
 * there is followed by its variable-length filename). `stat` only ever printed each entry's filename
 * and uncompressed size, so that's all this parses -- no compression/decompression, no encryption,
 * none of what `zip.js` is actually for.
 *
 * The real `stat()` syscall returns a `Stat` class whose fields are getters, not own-enumerable
 * properties -- `JSON.stringify` on it directly wouldn't print anything useful, so this builds a
 * plain object from the documented `StatFields` shape instead of relying on class serialization.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, getcwd, stat, isDirectory, open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: stat [OPTION]... FILE...
Display file or file system status.

  --help  display this help and exit`

function statToPlainObject(s) {
  return {
    dev: typeof s.dev === 'bigint' ? s.dev.toString() : s.dev,
    ino: s.ino,
    nlink: s.nlink,
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    rdev: s.rdev,
    size: s.size,
    blksize: s.blksize,
    blocks: s.blocks,
    atimeMs: s.atimeMs,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    birthtimeMs: s.birthtimeMs
  }
}

function extname(p) {
  const base = p.split('/').pop() ?? ''
  const idx = base.lastIndexOf('.')
  return idx <= 0 ? '' : base.slice(idx)
}

/**
 * Real ZIP central-directory parsing: find the End-Of-Central-Directory record (signature
 * `PK\x05\x06`, scanned back from the end since a ZIP comment of unknown length may follow it),
 * read the central directory's byte offset and entry count from it, then walk each 46-byte central
 * directory file header (signature `PK\x01\x02`) there, reading the uncompressed size (a 4-byte LE
 * field at header offset 24) and the variable-length filename that immediately follows each header.
 */
function listZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const EOCD_SIGNATURE = 0x06054b50
  const CENTRAL_DIR_SIGNATURE = 0x02014b50
  const EOCD_MIN_SIZE = 22

  let eocdOffset = -1
  const maxCommentSize = 65536
  const searchStart = Math.max(0, bytes.length - EOCD_MIN_SIZE - maxCommentSize)
  for (let i = bytes.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) { eocdOffset = i; break }
  }
  if (eocdOffset === -1) throw new Error('not a valid ZIP file (no end-of-central-directory record found)')

  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirOffset = view.getUint32(eocdOffset + 16, true)

  const entries = []
  let offset = centralDirOffset

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) break

    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const filename = new TextDecoder().decode(nameBytes)

    entries.push({ filename, uncompressedSize })
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

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

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const cwd = getcwd()
  const targets = args.length > 0 ? args.filter(arg => !arg.startsWith('-')) : [cwd]
  if (targets.length === 0) targets.push(cwd)

  let hasError = false

  for (const target of targets) {
    const fullPath = resolve(cwd, target)

    try {
      const s = stat(fullPath)

      let output = ''
      if (targets.length > 1) output += `${target}:\n`
      output += JSON.stringify(statToPlainObject(s), null, 2) + '\n'
      write(1, new TextEncoder().encode(output))

      if (extname(fullPath) === '.zip' && !isDirectory(fullPath)) {
        const bytes = readWholeFile(fullPath)
        const entries = listZipEntries(bytes)

        let zipOutput = '\nZIP Entries:\n'
        for (const entry of entries) zipOutput += `${entry.filename} (${entry.uncompressedSize} bytes)\n`
        write(1, new TextEncoder().encode(zipOutput))
      }

      if (targets.length > 1) write(1, new TextEncoder().encode('\n'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`stat: ${target}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`stat: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
