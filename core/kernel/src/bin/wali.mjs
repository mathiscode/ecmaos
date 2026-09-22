/**
 * ecmaOS's `/bin/wali` interpreter -- the real worker-hosted body `@zenfs/linux`'s own default
 * `binfmt_wasm` already points any `.wasm` file at via `execve` (matched on the `\0asm` magic
 * bytes, unconditionally -- `@zenfs/linux` does not distinguish WALI-format modules from plain
 * WASI-preview1 ones at the binfmt layer).
 *
 * This is never loaded directly, same as `bin/node.mjs`: bundled with zero import statements
 * (see that file's doc comment for why), then written to `/bin/wali` in the real filesystem at
 * boot.
 *
 * WALI is a different module format from WASI preview1, not an upgrade to it: a WALI module
 * imports directly from a `"wali"` namespace (`SYS_open`, `SYS_read`, `__cl_get_argc`, ...) --
 * musl compiled to target `@zenfs/linux`'s syscalls directly -- while a WASI-preview1 module
 * imports from `wasi_snapshot_preview1` (`fd_write`, `proc_exit`, ...), a separate standardized
 * ABI. The two are not interchangeable, and a preview1 `.wasm` will fail here with unresolved
 * imports (`uapi/wali`'s `link()` reports each one through `missing`) -- ecmaOS's own `.wasm`
 * execution path (`Kernel.executeWasm`, `tree/wasm.ts`) still runs those, unaffected by this file;
 * this interpreter is reachable only when something goes through `execve`/binfmt directly rather
 * than ecmaOS's own header-sniffing dispatch in `Kernel.execute`.
 */

import { ready, exit } from '@zenfs/linux/uapi/process'
import { open, read, close } from '@zenfs/linux/uapi/fs'
import { run } from '@zenfs/linux/uapi/wali'
import { runPreview1 } from './wasi-preview1.mjs'

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

const init = await ready

try {
  const source = await readWholeFile(init.exe)
  // run() only returns if the module falls out of main() without exiting -- __proc_exit tears
  // the thread down itself, same as bin/node.mjs's exit() for a program that calls it directly.
  // A `wasi_snapshot_preview1` module is translated onto the same syscalls (`wasi-preview1.mjs`);
  // anything else is a WALI module and goes straight to upstream's host.
  const module = await WebAssembly.compile(source)
  const isPreview1 = WebAssembly.Module.imports(module).some(entry => entry.module === 'wasi_snapshot_preview1')
  const code = isPreview1 ? await runPreview1(source) : await run(source)
  exit(code)
} catch (error) {
  console.error(error)
  exit(1)
}
