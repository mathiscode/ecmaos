/** `dpkg`: Debian's package tool, over `install`'s engine (see lib/install/dpkg.mjs) */

import { run } from './lib/install/dpkg.mjs'

const { argv, exit } = globalThis.ecmaosSyscalls

exit(await run(argv.slice(1)))
