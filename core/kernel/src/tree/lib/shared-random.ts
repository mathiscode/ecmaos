/**
 * `crypto.getRandomValues` refuses a view on a `SharedArrayBuffer`, and `@zenfs/linux`'s `/dev/random` and `/dev/urandom` pass it
 * one whenever a program reads them (the `read` syscall hands the device a view into the thread's shared memory). Without this,
 * `head -c 32 /dev/urandom` and any program that seeds itself from the device fail with `EIO`. A shared view is filled through a
 * private copy; everything else goes to the real function untouched.
 */

let installed = false

export function installSharedRandom(): void {
  if (installed) return
  const target = globalThis.crypto
  if (!target || typeof target.getRandomValues !== 'function') return
  installed = true

  const original = target.getRandomValues.bind(target) as <T extends ArrayBufferView | null>(array: T) => T
  const isShared = (view: ArrayBufferView) => typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer

  Object.defineProperty(target, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: <T extends ArrayBufferView | null>(array: T): T => {
      if (!array || !isShared(array)) return original(array)
      const bytes = new Uint8Array(array.byteLength)
      // The same limit the real function has, so a caller sees the same error for too much at once
      for (let at = 0; at < bytes.length; at += 0x10000) original(bytes.subarray(at, Math.min(at + 0x10000, bytes.length)))
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes)
      return array
    }
  })
}
