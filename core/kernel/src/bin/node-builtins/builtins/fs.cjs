/**
 * Node's `fs`, over the syscalls `/bin/node` exposes. The synchronous functions are the real ones; the callback and
 * promise forms run them on a later turn and hold the program open until they finish, which is the observable behaviour
 * of Node's thread pool. Errors carry `code`, `errno`, `syscall` and `path`, with the message Node writes.
 */

const sys = globalThis.ecmaosSyscalls
const { Buffer } = require('node:buffer')
const path = require('node:path')

const constants = {
  UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100, O_EXCL: 0o200, O_NOCTTY: 0o400, O_TRUNC: 0o1000, O_APPEND: 0o2000,
  O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000, O_SYNC: 0o4010000, O_DSYNC: 0o10000, O_NONBLOCK: 0o4000,
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o40000, S_IFCHR: 0o20000, S_IFBLK: 0o60000, S_IFIFO: 0o10000, S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
  S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100, S_IRWXG: 0o70, S_IRGRP: 0o40, S_IWGRP: 0o20, S_IXGRP: 0o10,
  S_IRWXO: 0o7, S_IROTH: 0o4, S_IWOTH: 0o2, S_IXOTH: 0o1,
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  UV_FS_COPYFILE_EXCL: 1, COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4, COPYFILE_FICLONE_FORCE: 4
}

const TEXT = {
  ENOENT: 'no such file or directory', EACCES: 'permission denied', EEXIST: 'file already exists', ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty', EINVAL: 'invalid argument', EPERM: 'operation not permitted',
  EBADF: 'bad file descriptor', EXDEV: 'cross-device link not permitted', ELOOP: 'too many symbolic links encountered',
  EMFILE: 'too many open files', ENOSPC: 'no space left on device', EROFS: 'read-only file system', EBUSY: 'resource busy or locked',
  EIO: 'i/o error', ENOSYS: 'function not implemented', ENAMETOOLONG: 'name too long', ESPIPE: 'invalid seek', EPIPE: 'broken pipe'
}

/** Runs a syscall, and gives its error Node's shape: `ENOENT: no such file or directory, open '/x'` with `path` */
function guard(syscall, file, run, dest) {
  try {
    return run()
  } catch (error) {
    if (error && typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code) && !error.__node) {
      const text = TEXT[error.code] ?? String(error.message ?? '').replace(/^E[A-Z0-9]+:\s*/, '').replace(/,\s*\w+$/, '')
      error.message = `${error.code}: ${text}, ${syscall}${file !== undefined ? ` '${file}'` : ''}${dest !== undefined ? ` -> '${dest}'` : ''}`
      error.syscall = syscall
      if (file !== undefined) error.path = file
      if (dest !== undefined) error.dest = dest
      error.__node = true
      Object.defineProperty(error, '__node', { enumerable: false })
    }
    throw error
  }
}

const invalid = (name, expected, actual) => Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${actual === null ? 'null' : typeof actual === 'object' ? 'an instance of ' + (actual.constructor?.name ?? 'Object') : `type ${typeof actual} (${String(actual)})`}`), { code: 'ERR_INVALID_ARG_TYPE' })

/** An absolute path from a string, a Buffer or a `file:` URL */
function toPath(value, name = 'path') {
  let text
  if (typeof value === 'string') text = value
  else if (value instanceof Uint8Array) text = Buffer.from(value).toString()
  else if (value && typeof value === 'object' && typeof value.href === 'string' && value.protocol === 'file:') text = decodeURIComponent(value.pathname)
  else throw invalid(name, 'of type string or an instance of Buffer or URL', value)
  if (text.includes('\0')) throw Object.assign(new TypeError(`The argument '${name}' must be a string, Uint8Array, or URL without null bytes. Received ${JSON.stringify(text)}`), { code: 'ERR_INVALID_ARG_VALUE' })
  return text.startsWith('/') ? text : path.resolve(sys.getcwd(), text)
}

const FLAGS = {
  r: 0, 'rs': 0, 'sr': 0, 'r+': 2, 'rs+': 2, 'sr+': 2,
  w: 0o1101, wx: 0o1301, xw: 0o1301, 'w+': 0o1102, 'wx+': 0o1302, 'xw+': 0o1302,
  a: 0o2101, ax: 0o2301, xa: 0o2301, 'a+': 0o2102, 'ax+': 0o2302, 'xa+': 0o2302
}
/** The `open` flags for a string such as `'w+'` or a number as it is */
function flagsOf(flag = 'r') {
  if (typeof flag === 'number') return flag
  if (!(flag in FLAGS)) throw Object.assign(new TypeError(`The argument 'flags' is invalid. Received '${flag}'`), { code: 'ERR_INVALID_ARG_VALUE' })
  return FLAGS[flag]
}

/** Descriptors opened for appending: ecmaOS has no `O_APPEND`, so each write goes to the end */
const appending = new Set()

const optionsOf = (options, fallback) => (typeof options === 'string' ? { encoding: options } : { ...fallback, ...(options ?? {}) })

function encode(bytes, encoding) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer
}

const TYPES = { 1: 'fifo', 2: 'char', 4: 'dir', 6: 'block', 8: 'file', 10: 'link', 12: 'socket' }

class Stats {
  constructor(stat) {
    this.dev = Number(stat.dev)
    this.mode = stat.mode
    this.nlink = Number(stat.nlink)
    this.uid = stat.uid
    this.gid = stat.gid
    this.rdev = Number(stat.rdev)
    this.blksize = Number(stat.blksize)
    this.ino = Number(stat.ino)
    this.size = Number(stat.size)
    this.blocks = Number(stat.blocks)
    this.atimeMs = stat.atimeMs
    this.mtimeMs = stat.mtimeMs
    this.ctimeMs = stat.ctimeMs
    this.birthtimeMs = stat.birthtimeMs ?? stat.ctimeMs
    this.atime = new Date(this.atimeMs)
    this.mtime = new Date(this.mtimeMs)
    this.ctime = new Date(this.ctimeMs)
    this.birthtime = new Date(this.birthtimeMs)
  }

  #is(type) { return (this.mode & constants.S_IFMT) === type }
  isFile() { return this.#is(constants.S_IFREG) }
  isDirectory() { return this.#is(constants.S_IFDIR) }
  isSymbolicLink() { return this.#is(constants.S_IFLNK) }
  isCharacterDevice() { return this.#is(constants.S_IFCHR) }
  isBlockDevice() { return this.#is(constants.S_IFBLK) }
  isFIFO() { return this.#is(constants.S_IFIFO) }
  isSocket() { return this.#is(constants.S_IFSOCK) }
}

class Dirent {
  constructor(name, type, parent) {
    this.name = name
    this.parentPath = parent
    this.path = parent
    this[Symbol.for('type')] = type
  }

  #is(kind) { return TYPES[this[Symbol.for('type')]] === kind }
  isFile() { return this.#is('file') }
  isDirectory() { return this.#is('dir') }
  isSymbolicLink() { return this.#is('link') }
  isCharacterDevice() { return this.#is('char') }
  isBlockDevice() { return this.#is('block') }
  isFIFO() { return this.#is('fifo') }
  isSocket() { return this.#is('socket') }
}

// Whole-file and descriptor operations

function readAll(fd) {
  const chunks = []
  for (;;) {
    const chunk = new Uint8Array(65536)
    const n = sys.read(fd, chunk, -1)
    if (n <= 0) break
    chunks.push(chunk.subarray(0, n))
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function bytesOf(data, encoding) {
  if (typeof data === 'string') return Buffer.from(data, encoding && encoding !== 'buffer' ? encoding : 'utf8')
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw invalid('data', 'of type string or an instance of Buffer, TypedArray, or DataView', data)
}

function readFileSync(file, options) {
  const { encoding, flag } = optionsOf(options, { flag: 'r' })
  if (typeof file === 'number') return encode(readAll(file), encoding)
  const target = toPath(file)
  return guard('open', target, () => {
    const fd = sys.open(target, flagsOf(flag), 0o666)
    try {
      if ((sys.fstat(fd).mode & constants.S_IFMT) === constants.S_IFDIR) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR', syscall: 'read' })
      return encode(readAll(fd), encoding)
    } finally {
      sys.close(fd)
    }
  })
}

function writeBytes(fd, bytes, position) {
  if (appending.has(fd)) position = Number(sys.fstat(fd).size)
  sys.writeAll(fd, bytes, position ?? -1)
}

function writeFileSync(file, data, options) {
  const { encoding, mode, flag } = optionsOf(options, { flag: 'w', mode: 0o666 })
  const bytes = bytesOf(data, encoding)
  if (typeof file === 'number') { writeBytes(file, bytes); return }
  const target = toPath(file)
  guard('open', target, () => {
    const flags = flagsOf(flag)
    const fd = sys.open(target, flags, mode)
    if (flags & constants.O_APPEND) appending.add(fd)
    try { writeBytes(fd, bytes) } finally { appending.delete(fd); sys.close(fd) }
  })
}

const appendFileSync = (file, data, options) => writeFileSync(file, data, { ...optionsOf(options, {}), flag: optionsOf(options, {}).flag ?? 'a' })

function openSync(file, flags = 'r', mode = 0o666) {
  const target = toPath(file)
  return guard('open', target, () => {
    const numeric = flagsOf(flags)
    const fd = sys.open(target, numeric, typeof mode === 'string' ? parseInt(mode, 8) : mode)
    if (numeric & constants.O_APPEND) appending.add(fd)
    return fd
  })
}

function closeSync(fd) {
  guard('close', undefined, () => { appending.delete(fd); sys.close(fd) })
}

function readSync(fd, buffer, offsetOrOptions, length, position) {
  let offset = offsetOrOptions
  if (offset !== null && typeof offset === 'object') ({ offset = 0, length = buffer.byteLength - offset, position = null } = offset)
  offset ??= 0
  length ??= buffer.byteLength - offset
  const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length)
  return guard('read', undefined, () => sys.read(fd, target, typeof position === 'number' || typeof position === 'bigint' ? Number(position) : -1))
}

function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
  let bytes
  let at = null
  if (typeof data === 'string') {
    bytes = Buffer.from(data, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : 'utf8')
    at = typeof offsetOrPosition === 'number' ? offsetOrPosition : null
  } else {
    const offset = offsetOrPosition ?? 0
    const length = typeof lengthOrEncoding === 'number' ? lengthOrEncoding : data.byteLength - offset
    bytes = new Uint8Array(data.buffer, data.byteOffset + offset, length)
    at = typeof position === 'number' ? position : null
  }
  return guard('write', undefined, () => {
    if (appending.has(fd)) at = Number(sys.fstat(fd).size)
    let written = 0
    while (written < bytes.byteLength) written += sys.write(fd, bytes.subarray(written), at === null ? -1 : at + written)
    return written
  })
}

// Metadata

function statSync(file, options) {
  const target = toPath(file)
  try {
    return new Stats(guard('stat', target, () => sys.stat(target)))
  } catch (error) {
    if (options?.throwIfNoEntry === false && error.code === 'ENOENT') return undefined
    throw error
  }
}

function lstatSync(file, options) {
  const target = toPath(file)
  try {
    return new Stats(guard('lstat', target, () => sys.lstat(target)))
  } catch (error) {
    if (options?.throwIfNoEntry === false && error.code === 'ENOENT') return undefined
    throw error
  }
}

const fstatSync = fd => new Stats(guard('fstat', undefined, () => sys.fstat(fd)))

function existsSync(file) {
  try { sys.access(toPath(file), 0); return true } catch { return false }
}

function accessSync(file, mode = 0) {
  const target = toPath(file)
  guard('access', target, () => sys.access(target, mode))
}

function readdirSync(directory, options) {
  const { withFileTypes, recursive, encoding } = optionsOf(options, {})
  const target = toPath(directory)
  const walk = (dir, prefix) => {
    const entries = guard('scandir', dir, () => sys.listdir(dir))
    const found = []
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      found.push(withFileTypes ? new Dirent(entry.name, entry.type, dir) : relative)
      if (recursive && entry.type === 4) found.push(...walk(`${dir}/${entry.name}`, relative))
    }
    return found
  }
  const found = walk(target, '')
  return encoding === 'buffer' && !withFileTypes ? found.map(name => Buffer.from(name)) : found
}

function mkdirSync(directory, options) {
  const { recursive, mode } = typeof options === 'number' ? { mode: options } : (options ?? {})
  const target = toPath(directory)
  const bits = typeof mode === 'string' ? parseInt(mode, 8) : (mode ?? 0o777)
  if (!recursive) { guard('mkdir', target, () => sys.mkdir(target, bits)); return undefined }
  let first
  const make = dir => {
    if (dir === '/' || existsSync(dir)) return
    make(path.dirname(dir))
    guard('mkdir', dir, () => sys.mkdir(dir, bits))
    first ??= dir
  }
  if (existsSync(target) && !statSync(target).isDirectory()) guard('mkdir', target, () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }) })
  make(target)
  return first
}

function mkdtempSync(prefix) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    const target = toPath(String(prefix) + Array.from(bytes, byte => alphabet[byte % alphabet.length]).join(''))
    if (existsSync(target)) continue
    guard('mkdtemp', target, () => sys.mkdir(target, 0o700))
    return target
  }
}

const rmdirSync = (directory, options) => {
  const target = toPath(directory)
  if (options?.recursive) { rmSync(target, { recursive: true, force: true }); return }
  guard('rmdir', target, () => sys.rmdir(target))
}

const unlinkSync = file => { const target = toPath(file); guard('unlink', target, () => sys.unlink(target)) }

function rmSync(file, options = {}) {
  const target = toPath(file)
  let stat
  try { stat = sys.lstat(target) } catch (error) {
    if (options.force && error.code === 'ENOENT') return
    guard('rm', target, () => { throw error })
  }
  if ((stat.mode & constants.S_IFMT) === constants.S_IFDIR) {
    if (!options.recursive) guard('rm', target, () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }) })
    guard('rm', target, () => sys.rmRecursive(target))
  } else {
    guard('rm', target, () => sys.unlink(target))
  }
}

function renameSync(from, to) {
  const a = toPath(from, 'oldPath')
  const b = toPath(to, 'newPath')
  guard('rename', a, () => sys.rename(a, b), b)
}

function copyFileSync(from, to, mode = 0) {
  const a = toPath(from, 'src')
  const b = toPath(to, 'dest')
  guard('copyfile', a, () => {
    if ((mode & constants.COPYFILE_EXCL) && existsSync(b)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    sys.copyFile(a, b, sys.stat(a).mode & 0o7777)
  }, b)
}

function cpSync(from, to, options = {}) {
  const a = toPath(from, 'src')
  const b = toPath(to, 'dest')
  const stat = statSync(a)
  if (stat.isDirectory()) {
    if (!options.recursive) guard('cp', a, () => { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }) })
    mkdirSync(b, { recursive: true })
    for (const name of readdirSync(a)) cpSync(`${a}/${name}`, `${b}/${name}`, options)
  } else if (!(options.force === false && existsSync(b))) {
    mkdirSync(path.dirname(b), { recursive: true })
    copyFileSync(a, b, options.errorOnExist ? constants.COPYFILE_EXCL : 0)
  }
}

const symlinkSync = (target, file) => { const link = toPath(file); guard('symlink', String(target), () => sys.symlink(String(target), link), link) }
const linkSync = (existing, file) => { const a = toPath(existing, 'existingPath'); const b = toPath(file, 'newPath'); guard('link', a, () => sys.link(a, b), b) }
const readlinkSync = (file, options) => { const target = toPath(file); const value = guard('readlink', target, () => sys.readlink(target)); return optionsOf(options, {}).encoding === 'buffer' ? Buffer.from(value) : value }
const realpathSync = Object.assign(file => { const target = toPath(file); return guard('realpath', target, () => sys.realpath(target)) }, { native: file => realpathSync(file) })
const chmodSync = (file, mode) => { const target = toPath(file); guard('chmod', target, () => sys.chmod(target, typeof mode === 'string' ? parseInt(mode, 8) : mode)) }
const chownSync = (file, uid, gid) => { const target = toPath(file); guard('chown', target, () => sys.chown(target, uid, gid)) }
const toMs = time => (time instanceof Date ? time.getTime() : typeof time === 'string' ? Date.parse(time) : Number(time) * 1000)
const utimesSync = (file, atime, mtime) => { const target = toPath(file); guard('utime', target, () => sys.utimes(target, toMs(atime), toMs(mtime))) }
const truncateSync = (file, length = 0) => {
  if (typeof file === 'number') { guard('ftruncate', undefined, () => sys.ftruncate(file, length)); return }
  const target = toPath(file)
  guard('open', target, () => { const fd = sys.open(target, constants.O_WRONLY, 0o666); try { sys.ftruncate(fd, length) } finally { sys.close(fd) } })
}
const ftruncateSync = (fd, length = 0) => guard('ftruncate', undefined, () => sys.ftruncate(fd, length))
const fsyncSync = fd => guard('fsync', undefined, () => sys.fsync(fd))

// The callback and promise forms: the same work, on a later turn, with the program held open until it is done

const sync = {
  readFile: readFileSync, writeFile: writeFileSync, appendFile: appendFileSync, open: openSync, close: closeSync, stat: statSync, lstat: lstatSync, fstat: fstatSync,
  access: accessSync, readdir: readdirSync, mkdir: mkdirSync, mkdtemp: mkdtempSync, rmdir: rmdirSync, rm: rmSync, unlink: unlinkSync, rename: renameSync,
  copyFile: copyFileSync, cp: cpSync, symlink: symlinkSync, link: linkSync, readlink: readlinkSync, realpath: realpathSync, chmod: chmodSync, chown: chownSync,
  lchown: chownSync, utimes: utimesSync, lutimes: utimesSync, truncate: truncateSync, ftruncate: ftruncateSync, fsync: fsyncSync, fdatasync: fsyncSync
}

const later = run => new Promise((resolve, reject) => {
  const release = process.__ecmaos.hold()
  setTimeout(() => {
    try { resolve(run()) } catch (error) { reject(error) } finally { release() }
  }, 0)
})

const callbackForms = {}
const promiseForms = {}
for (const [name, fn] of Object.entries(sync)) {
  callbackForms[name] = (...args) => {
    const callback = args.pop()
    if (typeof callback !== 'function') throw invalid('cb', 'of type function', callback)
    later(() => fn(...args)).then(result => callback(null, result), error => callback(error))
  }
  promiseForms[name] = (...args) => later(() => fn(...args))
}
callbackForms.exists = (file, callback) => { later(() => existsSync(file)).then(callback) }
callbackForms.read = (fd, buffer, ...rest) => {
  const callback = rest.pop()
  later(() => readSync(fd, buffer, ...rest)).then(n => callback(null, n, buffer), error => callback(error))
}
callbackForms.write = (fd, data, ...rest) => {
  const callback = rest.pop()
  later(() => writeSync(fd, data, ...rest)).then(n => callback(null, n, data), error => callback(error))
}
Object.defineProperty(callbackForms.exists, Symbol.for('nodejs.util.promisify.custom'), { value: file => later(() => existsSync(file)) })

class FileHandle {
  constructor(fd) { this.fd = fd }
  readFile(options) { return later(() => readFileSync(this.fd, options)) }
  writeFile(data, options) { return later(() => writeFileSync(this.fd, data, options)) }
  appendFile(data, options) { return later(() => writeFileSync(this.fd, data, options)) }
  read(buffer, ...rest) { return later(() => ({ bytesRead: readSync(this.fd, buffer, ...rest), buffer })) }
  write(data, ...rest) { return later(() => ({ bytesWritten: writeSync(this.fd, data, ...rest), buffer: data })) }
  stat() { return later(() => fstatSync(this.fd)) }
  truncate(length) { return later(() => ftruncateSync(this.fd, length)) }
  sync() { return later(() => fsyncSync(this.fd)) }
  datasync() { return this.sync() }
  close() { return later(() => closeSync(this.fd)) }
  async * readLines() {
    const text = (await this.readFile('utf8')).split(/\r?\n/)
    if (text.at(-1) === '') text.pop()
    yield * text
  }
  async [Symbol.asyncDispose]() { await this.close() }
}
promiseForms.open = (file, flags, mode) => later(() => new FileHandle(openSync(file, flags, mode)))
promiseForms.readFile = (file, options) => later(() => readFileSync(file instanceof FileHandle ? file.fd : file, options))
promiseForms.writeFile = (file, data, options) => later(() => writeFileSync(file instanceof FileHandle ? file.fd : file, data, options))
promiseForms.access = (file, mode) => later(() => accessSync(file, mode))
promiseForms.constants = constants
promiseForms.opendir = directory => later(() => opendirSync(directory))

class Dir {
  constructor(directory) { this.path = directory; this._entries = readdirSync(directory, { withFileTypes: true }); this._at = 0 }
  readSync() { return this._entries[this._at++] ?? null }
  read(callback) { const entry = this.readSync(); return callback ? (setTimeout(callback, 0, null, entry), undefined) : later(() => entry) }
  closeSync() { this._at = this._entries.length }
  close(callback) { this.closeSync(); return callback ? (setTimeout(callback, 0), undefined) : later(() => undefined) }
  async * [Symbol.asyncIterator]() { for (let entry = this.readSync(); entry; entry = this.readSync()) yield entry }
}
const opendirSync = directory => new Dir(toPath(directory))

// Streams

function createReadStream(file, options) {
  const { Readable } = require('node:stream')
  const { start = 0, end = Infinity, highWaterMark = 65536, encoding, flags = 'r', mode, fd: given, autoClose = true } = optionsOf(options, {})
  let fd = given
  let position = start
  const stream = new Readable({
    highWaterMark,
    encoding,
    construct(callback) {
      if (fd !== undefined) { callback(); return }
      later(() => { fd = openSync(file, flags, mode) }).then(() => { stream.emit('open', fd); stream.emit('ready'); callback() }, callback)
    },
    read(size) {
      later(() => {
        const length = Math.min(size, end - position + 1)
        if (length <= 0) return null
        const chunk = new Uint8Array(length)
        const n = sys.read(fd, chunk, position)
        position += n
        return n > 0 ? Buffer.from(chunk.buffer, 0, n) : null
      }).then(chunk => stream.push(chunk), error => stream.destroy(error))
    },
    destroy(error, callback) {
      if (fd !== undefined && autoClose) { try { closeSync(fd) } catch { /* closed already */ } }
      callback(error)
    }
  })
  stream.path = typeof file === 'string' ? file : undefined
  Object.defineProperty(stream, 'bytesRead', { get: () => position - start })
  return stream
}

function createWriteStream(file, options) {
  const { Writable } = require('node:stream')
  const { start, flags = 'w', mode, fd: given, encoding, autoClose = true } = optionsOf(options, {})
  let fd = given
  let position = start
  let written = 0
  const stream = new Writable({
    decodeStrings: true,
    defaultEncoding: encoding ?? 'utf8',
    construct(callback) {
      if (fd !== undefined) { callback(); return }
      later(() => { fd = openSync(file, flags, mode) }).then(() => { stream.emit('open', fd); stream.emit('ready'); callback() }, callback)
    },
    write(chunk, _encoding, callback) {
      later(() => {
        const n = writeSync(fd, chunk, 0, chunk.byteLength, position)
        if (position !== undefined) position += n
        written += n
      }).then(() => callback(), callback)
    },
    destroy(error, callback) {
      if (fd !== undefined && autoClose) { try { closeSync(fd) } catch { /* closed already */ } }
      callback(error)
    }
  })
  stream.path = typeof file === 'string' ? file : undefined
  Object.defineProperty(stream, 'bytesWritten', { get: () => written })
  return stream
}

const { EventEmitter } = require('node:events')

/** There is nothing to watch with: a watcher that never fires, which closes */
function watch() {
  const watcher = new EventEmitter()
  watcher.close = () => { watcher.emit('close') }
  watcher.ref = () => watcher
  watcher.unref = () => watcher
  return watcher
}
const watchFile = () => new EventEmitter()
const unwatchFile = () => {}

module.exports = {
  constants,
  ...constants,
  Stats,
  Dirent,
  Dir,
  ReadStream: createReadStream,
  WriteStream: createWriteStream,
  readFileSync, writeFileSync, appendFileSync, openSync, closeSync, readSync, writeSync,
  statSync, lstatSync, fstatSync, existsSync, accessSync, readdirSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, unlinkSync,
  renameSync, copyFileSync, cpSync, symlinkSync, linkSync, readlinkSync, realpathSync, chmodSync, chownSync, lchownSync: chownSync,
  utimesSync, lutimesSync: utimesSync, truncateSync, ftruncateSync, fsyncSync, fdatasyncSync: fsyncSync, opendirSync,
  fchmodSync: () => { throw Object.assign(new Error('ENOSYS: function not implemented, fchmod'), { code: 'ENOSYS' }) },
  ...callbackForms,
  createReadStream,
  createWriteStream,
  watch,
  watchFile,
  unwatchFile,
  promises: promiseForms
}
