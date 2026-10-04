/** Print or check sha1 checksums. */

import { start } from './lib/checksum.mjs'

await start('sha1sum', 'sha1')
