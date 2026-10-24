/**
 * `/dev/hwrng` (misc `10:183`): the hardware random number generator, which here is the browser's (`crypto.getRandomValues`,
 * the source `/dev/random` already reads). On Linux it is what `rngd` feeds the kernel's pool from; a read gives as many random
 * bytes as were asked for. The device is `hw_random` in sysfs, as on Linux, with `rng_current` and `rng_available`.
 */

import { Class } from '@zenfs/linux'
import type { FileOperations } from '@zenfs/linux'
import { withErrno } from 'kerium'
import type { KernelCharDevice, KernelDevice } from '@ecmaos/types'

/** `crypto.getRandomValues` fills at most 64 KiB at a time */
const Chunk = 0x10000

const misc_class = new Class('misc', {
  dev_attrs: {
    rng_current: { mode: 0o444, show: () => 'webcrypto\n' },
    rng_available: { mode: 0o444, show: () => 'webcrypto\n' }
  },
  dev_node: () => ({ name: 'hwrng', mode: 0o600 })
})

export const hwrngOperations: FileOperations = {
  read(_file, buffer, start, end) {
    // the buffer may be shared memory, which `getRandomValues` refuses, so the bytes are made apart and copied in
    const chunk = new Uint8Array(Math.min(Chunk, Math.max(end - start, 0)))
    for (let at = start; at < end; at += Chunk) {
      const part = chunk.subarray(0, Math.min(Chunk, end - at))
      buffer.set(crypto.getRandomValues(part), at)
    }
    return Math.max(end - start, 0)
  },
  write() { throw withErrno('EINVAL') }
}

export const HwrngDevice: KernelDevice = {
  pkg: { name: 'hwrng', version: '0.1.0', description: 'The hardware random number generator (/dev/hwrng), which is the browser\'s' },
  async getDrivers(): Promise<KernelCharDevice[]> {
    return [{ name: 'hw_random', major: 10, minor: 183, class: misc_class, ops: hwrngOperations }]
  }
}
