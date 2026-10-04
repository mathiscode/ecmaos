/** Print or check sha384 checksums. */

import { start } from './lib/checksum.mjs'

await start('sha384sum', 'sha384')
