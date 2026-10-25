/**
 * The file system tsrs.wasm reads and writes through (its `HostFileSystem`), over the process's own syscalls, so the
 * compiler sees the machine's files as any program does. Everything is synchronous, as the module's host calls are.
 * `realpath` is lexical: a symbolic link in the middle of a path is not resolved.
 */

import { NotFoundError } from '@tsrs/wasm/core'

const dirname = path => path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

/** Collapses `.`, `..` and empty segments of an absolute path */
function resolve(path) {
  const stack = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  return `/${stack.join('/')}`
}

const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFREG = 0x8000
const S_IFLNK = 0xa000
const O_RDONLY = 0
const O_WRONLY = 1
const O_CREAT = 0x40
const O_TRUNC = 0x200

/** A missing path, or one under a file, is "not found" to the compiler; any other error is the compiler's to report */
const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || /ENOENT|ENOTDIR/.test(String(error?.message))

export function readFileBytes(sys, path) {
  const fd = sys.open(path, O_RDONLY)
  try {
    const chunks = []
    let total = 0
    while (true) {
      const buffer = new Uint8Array(1 << 20)
      const n = sys.read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      total += n
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes
  } finally {
    sys.close(fd)
  }
}

/** `sys` is `globalThis.ecmaosSyscalls` */
export function systemFileSystem(sys) {
  const guard = (path, action) => {
    try { return action() } catch (error) {
      if (missing(error)) throw new NotFoundError(path)
      throw error
    }
  }
  const makeDirs = path => {
    if (path === '/' || path === '.') return
    try { if (sys.isDirectory(path)) return } catch { /* made below */ }
    makeDirs(dirname(path))
    try { sys.mkdir(path, 0o755) } catch (error) { if (!sys.isDirectory(path)) throw error }
  }
  return {
    readFile: path => guard(path, () => readFileBytes(sys, path)),
    stat(path) {
      return guard(path, () => {
        const s = sys.stat(path)
        const type = s.mode & S_IFMT
        return { kind: type === S_IFDIR ? 'd' : type === S_IFREG ? 'f' : 'o', size: s.size, mtimeNs: BigInt(Math.round(s.mtimeMs * 1e6)) }
      })
    },
    readDir(path) {
      return guard(path, () => sys.readdir(path).map(name => {
        const type = sys.lstat(`${path.replace(/\/$/, '')}/${name}`).mode & S_IFMT
        return [type === S_IFLNK ? 'l' : type === S_IFDIR ? 'd' : type === S_IFREG ? 'f' : 'o', name]
      }))
    },
    realpath: path => resolve(path),
    writeFile(path, data, append) {
      makeDirs(dirname(path))
      const fd = sys.open(path, O_WRONLY | O_CREAT | (append ? 0 : O_TRUNC), 0o644)
      try {
        let position = append ? sys.stat(path).size : 0
        for (let offset = 0; offset < data.length;) {
          const n = sys.write(fd, data.subarray(offset), position)
          offset += n
          position += n
        }
      } finally {
        sys.close(fd)
      }
    },
    remove: path => guard(path, () => sys.rmRecursive(path)),
    chtimes(path, atimeNs, mtimeNs) {
      try { sys.utimes(path, Number(atimeNs) / 1e9, Number(mtimeNs) / 1e9) } catch { /* the compiler only stamps outputs */ }
    }
  }
}
