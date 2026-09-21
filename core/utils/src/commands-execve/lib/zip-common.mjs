/**
 * Shared plumbing for the real `execve`'d `zip` and `unzip` programs: whole-file I/O over the raw
 * syscalls, recursive `mkdir`, `path.relative`, stdout/stderr writers, and the `-l` listing both
 * commands print. Imports `@zip.js/zip.js` once so both bundles configure it identically:
 * `useWebWorkers: false`, because these programs already run inside a worker and zip.js's own
 * nested worker pool would only add a spawn per archive for no parallelism gain.
 */

import * as zip from '@zip.js/zip.js'
import { basename } from './path-utils.mjs'

const { writeAll, read, open, close, stat, mkdir, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

zip.configure({ useWebWorkers: false })

export { zip }

const encoder = new TextEncoder()

export const out = text => writeAll(1, encoder.encode(text + '\n'))
export const err = text => writeAll(2, encoder.encode(text + '\n'))

export function readWholeFile(fullPath) {
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

export function writeWholeFile(fullPath, bytes) {
  const fd = open(fullPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    writeAll(fd, bytes)
  } finally {
    close(fd)
  }
}

/** The raw `mkdir(2)` is single-level, so create every segment from the root down. */
export function mkdirRecursive(targetPath) {
  let current = ''
  for (const segment of targetPath.split('/').filter(Boolean)) {
    current += '/' + segment
    try { mkdir(current, 0o755) } catch { /* already exists */ }
  }
}

export function exists(fullPath) {
  try { stat(fullPath); return true } catch { return false }
}

/** POSIX `path.relative` for two absolute, normalized paths. */
export function relative(from, to) {
  const a = from.split('/').filter(Boolean)
  const b = to.split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

export const errorMessage = error => (error instanceof Error ? error.message : 'Unknown error')

/** Prints the `unzip -l`-style table for an archive on disk. Returns the exit code. */
export async function listZip(zipfilePath, who) {
  try {
    const reader = new zip.ZipReader(new zip.BlobReader(new Blob([readWholeFile(zipfilePath)])))
    const entries = await reader.getEntries()

    if (entries.length === 0) {
      out('Archive:  ' + basename(zipfilePath))
      out('  Empty archive')
      await reader.close()
      return 0
    }

    let maxLength = 0
    let maxSize = 0
    for (const entry of entries) {
      if (entry.filename.length > maxLength) maxLength = entry.filename.length
      const size = entry.uncompressedSize || 0
      if (size > maxSize) maxSize = size
    }

    const sizeWidth = Math.max(12, String(maxSize).length)
    const nameWidth = Math.max(20, maxLength)
    const rule = `  ${'-'.repeat(sizeWidth)}  ${'-'.repeat(10)}  ${'-'.repeat(5)}  ${'-'.repeat(nameWidth)}`

    out(`Archive:  ${basename(zipfilePath)}`)
    out('')
    out('  Length      Date  Time    Name'.padEnd(nameWidth + sizeWidth + 20))
    out(rule)

    let totalLength = 0
    for (const entry of entries) {
      const length = entry.uncompressedSize || 0
      totalLength += length

      let date = '--'
      let time = '--'
      if (entry.lastModDate) {
        const d = new Date(entry.lastModDate)
        date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getFullYear()).slice(-2)}`
        time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }

      const name = entry.directory ? entry.filename + '/' : entry.filename
      const lengthStr = entry.directory ? '' : String(length).padStart(sizeWidth)
      out(`  ${lengthStr.padEnd(sizeWidth)}  ${date.padEnd(10)}  ${time.padEnd(5)}  ${name}`)
    }

    out(rule)
    out(`  ${String(totalLength).padStart(sizeWidth)}                      ${entries.length} file${entries.length !== 1 ? 's' : ''}`)

    await reader.close()
    return 0
  } catch (error) {
    err(`${who} error: ${errorMessage(error)}`)
    return 1
  }
}
