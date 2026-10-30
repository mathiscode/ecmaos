/**
 * File helpers for `install` and `uninstall`, over the raw syscalls. `read()` never blocks past what is buffered and
 * may return less than was asked for before the end of a file, so a whole file is read until `read()` returns 0.
 */

const { open, read, close, writeAll, mkdir, access, rename, unlink, readdir, getpid, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

export const dirname = path => path.slice(0, path.lastIndexOf('/')) || '/'
export const exists = path => { try { access(path, 0); return true } catch { return false } }
export const names = path => readdir(path).map(entry => (typeof entry === 'string' ? entry : entry.name))

export function mkdirp(path, mode = 0o755) {
  if (path === '/' || exists(path)) return
  mkdirp(dirname(path), mode)
  try {
    mkdir(path, mode)
  } catch (error) {
    // the syscall's message names no path
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export function readBytes(path) {
  const fd = open(path, O_RDONLY)
  const chunks = []
  try {
    for (;;) {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
    }
  } finally {
    close(fd)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export const readText = path => decoder.decode(readBytes(path))

/** The JSON in `path`, or `fallback` when there is no such file or it does not parse */
export function readJson(path, fallback) {
  try { return JSON.parse(readText(path)) } catch { return fallback }
}

export function writeBytes(path, bytes, mode = 0o644) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode)
  try {
    writeAll(fd, bytes)
  } finally {
    close(fd)
  }
}

/** Writes `path` whole or not at all: a temporary file beside it, renamed over it */
export function writeAtomic(path, bytes, mode = 0o644) {
  mkdirp(dirname(path))
  const temporary = `${path}.${getpid()}.tmp`
  try {
    writeBytes(temporary, typeof bytes === 'string' ? encoder.encode(bytes) : bytes, mode)
    rename(temporary, path)
  } catch (error) {
    try { unlink(temporary) } catch { /* never written */ }
    throw error
  }
}

/** Runs `task` on each item, at most `limit` at a time, and gives the results in order */
export async function pool(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** `12.3 kB`, as npm and apt show a size */
export function size(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++ }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
