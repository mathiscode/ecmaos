/** `apt-get`: Debian's package tool, over `install`'s engine (see lib/install/apt.mjs) */

import { run } from './lib/install/apt.mjs'

const { argv, exit } = globalThis.ecmaosSyscalls

exit(await run('apt-get', argv.slice(1)))
