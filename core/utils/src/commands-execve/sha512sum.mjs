/** Print or check sha512 checksums. */

import { start } from './lib/checksum.mjs'

await start('sha512sum', 'sha512')
