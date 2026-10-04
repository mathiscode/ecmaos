/** Print or check md5 checksums. */

import { start } from './lib/checksum.mjs'

await start('md5sum', 'md5')
