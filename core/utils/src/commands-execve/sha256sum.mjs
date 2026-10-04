/** Print or check sha256 checksums. */

import { start } from './lib/checksum.mjs'

await start('sha256sum', 'sha256')
