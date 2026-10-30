/** `pacman`: Arch's package tool, over `install`'s engine (see lib/install/pacman.mjs) */

import { run } from './lib/install/pacman.mjs'

const { argv, exit } = globalThis.ecmaosSyscalls

exit(await run(argv.slice(1)))
