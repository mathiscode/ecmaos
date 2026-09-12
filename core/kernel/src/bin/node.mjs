/**
 * ecmaOS's `/bin/node` interpreter -- the real worker-hosted body `binfmt_js` (registered by
 * `@zenfs/linux` itself) points at for any plain JS/ESM program that goes through `execve`.
 *
 * This file is never loaded directly. It is bundled (see `vite-plugin-bin-node.ts`) into one
 * self-contained module with zero import statements, then written to `/bin/node` in the real
 * filesystem at boot. That bundling is not an optimization -- it is required: the kernel loads an
 * interpreter as a `blob:`/`data:` URL module (there is no real file URL to give a Worker), and
 * neither URL scheme gives a module resolver a base to resolve a bare specifier like
 * `@zenfs/linux/uapi/process` against. A bundle with no imports left has nothing to resolve.
 *
 * The program it loads is under the same constraint. This interpreter does not run programs that
 * import anything themselves -- there is no import-rewriting here (the SWAPI mechanism
 * `Kernel.replaceImports` uses for main-thread apps would need its own worker-side port, real
 * scope of its own, not a detail of getting a first program running). A self-contained script,
 * i.e. one with no import/require statements, is what `/bin/node` can run today.
 *
 * A loaded program that DOES want real syscalls (`open`/`read`/`write`/`getcwd`/...) has a second,
 * separate obstacle even once it stops importing anything: it would still need its own bundled
 * copy of `@zenfs/linux/uapi/*` if it tried to `import` those directly, and that copy's module-
 * level state (`uapi/base.ts`'s `ready`, the shared-memory syscall channel `@zenfs/linux` sets up
 * by resolving it when the real `init` message arrives) is private to *this* module instance --
 * the one that actually received that message, being the real Worker entrypoint. A separately
 * bundled copy's own `ready` never resolves; confirmed by hand, it hangs forever. So this
 * interpreter exposes its own already-initialized syscall wrappers on `globalThis.ecmaosSyscalls`
 * before loading the program below -- the one way a loaded program can make a real syscall today
 * without a second, unresolvable copy of `uapi`'s init handshake.
 */

import { ready, exit } from '@zenfs/linux/uapi/process'
import {
  open, read, close, write, getcwd,
  mkdir, rmdir, unlink, rename, chmod, stat, access, getdents,
  link, symlink, readlink
} from '@zenfs/linux/uapi/fs'
import { syscall_async } from '@zenfs/linux/uapi/base'

const O_RDONLY = 0
const O_WRONLY = 1
const O_CREAT = 0x40
const O_TRUNC = 0x200
const O_DIRECTORY = 0x10000
const S_IFMT = 0xf000
const S_IFDIR = 0x4000

/**
 * `readdir`/`copyFile`/recursive `rm` are userspace conveniences over raw syscalls in every real
 * libc too -- there is no kernel primitive for any of them. Built once here, alongside the syscall
 * wrappers, rather than duplicated in every coreutil program that needs one (mirrors how `ls`/`cp`/
 * `rm` all link against the same libc instead of reimplementing `readdir(3)` each time).
 */

/**
 * Real directory listing: `open(O_DIRECTORY)` + one `getdents` + `close`.
 *
 * Just one call, not a loop -- confirmed by reading `@zenfs/linux`'s own handler (`syscall/fs.js`):
 * `getdents` re-reads the *entire* directory via `vfs.readdir` on every call and writes as much as
 * fits in the return region, with no cursor/file-position tracking of its own. A repeat call would
 * hand back the exact same entries again (not "the rest"), so looping "until empty" never
 * terminates -- confirmed by hand, `rm -r` on a real directory hung forever until this was fixed to
 * call it once. A directory whose real listing doesn't fit in one region write is a known limit of
 * this syscall as `@zenfs/linux` implements it today, not something more looping here can fix.
 */
function readdir(path) {
  const fd = open(path, O_RDONLY | O_DIRECTORY, 0)
  try {
    const names = []
    const entries = getdents(fd)
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue
      names.push(entry.name)
    }
    return names
  } finally {
    close(fd)
  }
}

/** `true` if `path` is a directory, via a real `stat`, not a name-based guess. */
function isDirectory(path) {
  return (stat(path).mode & S_IFMT) === S_IFDIR
}

/** Real file copy: read the source in chunks, write them to a freshly created/truncated destination. */
function copyFile(source, destination) {
  const srcFd = open(source, O_RDONLY, 0)
  try {
    const destFd = open(destination, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    try {
      const chunkSize = 65536
      while (true) {
        const buffer = new Uint8Array(chunkSize)
        const n = read(srcFd, buffer, -1)
        if (n <= 0) break
        let offset = 0
        while (offset < n) offset += write(destFd, buffer.subarray(offset, n), -1)
        if (n < chunkSize) break
      }
    } finally {
      close(destFd)
    }
  } finally {
    close(srcFd)
  }
}

/** Recursively remove a real directory tree: `readdir` + recurse, `unlink` files, `rmdir` on the way back up. */
function rmRecursive(path) {
  if (isDirectory(path)) {
    for (const name of readdir(path)) rmRecursive(`${path}/${name}`)
    rmdir(path)
  } else {
    unlink(path)
  }
}

/** `read()` never blocks past what's buffered, so read in a loop until a short read ends it. */
async function readWholeFile(path) {
  const fd = open(path, 0 /* O_RDONLY */)
  const chunkSize = 65536
  const chunks = []

  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      if (n < chunkSize) break
    }
  } finally {
    close(fd)
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

/** Base64-encode into a `data:` URL, which (unlike `blob:`) a bare Node worker_threads Worker can import too. */
function toDataUrl(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return 'data:text/javascript;base64,' + btoa(binary)
}

const init = await ready

// Expose this module's own already-initialized syscall wrappers for the loaded program to use --
// see the doc comment above for why a program can't get working ones of its own by importing
// `@zenfs/linux/uapi/*` directly. Grows as more coreutils move onto real execve (see the
// `feat/1.0.0-execve-commands` migration); still deliberately just what's been needed so far, not
// all of `uapi/*` up front.
//
// `readdir`/`isDirectory`/`copyFile`/`rmRecursive` are this interpreter's own userspace helpers
// (built above from raw syscalls), not `@zenfs/linux` exports -- there is no kernel primitive for
// any of them in real Linux either; every libc builds them the same way over `getdents`/`open`+
// `read`+`write`/recursive `unlink`+`rmdir`. Provided once here so migrated coreutils (`cp`, `rm`,
// `mv`, ...) don't each reimplement directory walking.
//
// `custom` is `syscall_async` itself, not `syscall`/`syscall_raw` -- a main-thread-only capability
// like `window_create` can take arbitrarily long (a real window is created synchronously today, but
// a future capability like `bt_request_device` waits on a user gesture with no bound at all), and
// the sync path blocks this whole worker thread via `Atomics.wait` with no timeout. `syscall_async`
// resolves a plain Promise on the kernel's `'return'` postMessage instead, so the worker stays free.
globalThis.ecmaosSyscalls = {
  open, read, write, close, getcwd, exit, custom: syscall_async,
  mkdir, rmdir, unlink, rename, chmod, stat, access,
  readdir, isDirectory, copyFile, rmRecursive,
  link, symlink, readlink,
  O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY,
  // `argv`/`env` come straight from the real `init` message (`Thread.start`'s `host.post`,
  // `thread.js`) -- `argv[0]` is the program's own path (real `execve` convention), so a program's
  // real arguments are `argv.slice(1)`. `cwd` is a syscall (`getcwd()`), not `init.cwd`, since the
  // process may `chdir()` after starting and `getcwd()` always reflects that; `init.cwd` is only
  // what the shell's cwd was at the moment this program was launched.
  argv: init.argv, env: init.env
}

try {
  const source = await readWholeFile(init.exe)
  await import(toDataUrl(source))
  exit(0)
} catch (error) {
  // A program that calls exit() itself never reaches here -- exit() tears the thread down.
  console.error(error)
  exit(1)
}
