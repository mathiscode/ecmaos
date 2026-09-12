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
import { open, read, close, write, getcwd } from '@zenfs/linux/uapi/fs'
import { syscall_async } from '@zenfs/linux/uapi/base'

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
// `@zenfs/linux/uapi/*` directly. Deliberately a small, fixed set (not all of `uapi/*`): only what
// a syscall-only coreutil-shaped program plausibly needs today.
//
// `custom` is `syscall_async` itself, not `syscall`/`syscall_raw` -- a main-thread-only capability
// like `window_create` can take arbitrarily long (a real window is created synchronously today, but
// a future capability like `bt_request_device` waits on a user gesture with no bound at all), and
// the sync path blocks this whole worker thread via `Atomics.wait` with no timeout. `syscall_async`
// resolves a plain Promise on the kernel's `'return'` postMessage instead, so the worker stays free.
globalThis.ecmaosSyscalls = { open, read, write, close, getcwd, exit, custom: syscall_async }

try {
  const source = await readWholeFile(init.exe)
  await import(toDataUrl(source))
  exit(0)
} catch (error) {
  // A program that calls exit() itself never reaches here -- exit() tears the thread down.
  console.error(error)
  exit(1)
}
