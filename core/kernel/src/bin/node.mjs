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
 */

import { ready, exit } from '@zenfs/linux/uapi/process'
import { open, read, close } from '@zenfs/linux/uapi/fs'

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

try {
  const source = await readWholeFile(init.exe)
  await import(toDataUrl(source))
  exit(0)
} catch (error) {
  // A program that calls exit() itself never reaches here -- exit() tears the thread down.
  console.error(error)
  exit(1)
}
