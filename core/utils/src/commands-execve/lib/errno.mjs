/**
 * errno names and the text GNU coreutils print for them (`strerror` under the C locale). Syscall errors carry a `code`
 * (`ENOENT`); an error that lost it (rethrown through a message) is matched on the name inside its text.
 */

const REASONS = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  EIO: 'Input/output error',
  EBADF: 'Bad file descriptor',
  EACCES: 'Permission denied',
  EBUSY: 'Device or resource busy',
  EEXIST: 'File exists',
  EXDEV: 'Invalid cross-device link',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EINVAL: 'Invalid argument',
  EMFILE: 'Too many open files',
  ENOTTY: 'Inappropriate ioctl for device',
  EFBIG: 'File too large',
  ENOSPC: 'No space left on device',
  ESPIPE: 'Illegal seek',
  EROFS: 'Read-only file system',
  EMLINK: 'Too many links',
  EPIPE: 'Broken pipe',
  ENAMETOOLONG: 'File name too long',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  ENXIO: 'No such device or address',
  ENODEV: 'No such device',
  ENOEXEC: 'Exec format error',
  ENOSYS: 'Function not implemented',
  ETXTBSY: 'Text file busy'
}

const NAMES = Object.keys(REASONS)

/** The errno name (`ENOENT`) of a thrown syscall error, or `undefined` when it is not one */
export function codeOf(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code in REASONS) return error.code
  const text = error instanceof Error ? error.message : String(error)
  return NAMES.find(name => text.includes(name))
}

/** The GNU wording for an error: `No such file or directory`; the error's own message when it is not an errno */
export function reasonOf(error) {
  const code = codeOf(error)
  if (code) return REASONS[code]
  return error instanceof Error ? error.message : String(error)
}

/** `true` when `error` is the errno `name` */
export function is(error, name) {
  return codeOf(error) === name
}

/** An error carrying an errno `code`, as a syscall throws */
export function errnoError(code, message = code) {
  return Object.assign(new Error(message), { code })
}

/** A file name as GNU `quotef` shows it in a message: bare when plain, otherwise single-quoted for a shell */
export function quotef(name) {
  if (name !== '' && !name.startsWith('~') && /^[A-Za-z0-9_@%+,./~-]+$/.test(name)) return name
  return `'${name.replace(/'/g, "'\\''")}'`
}
