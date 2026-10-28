/** Print or check BLAKE2b-512 checksums. */

import { start } from './lib/checksum.mjs'

await start('b2sum', 'blake2b')
