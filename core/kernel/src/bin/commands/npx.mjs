/** `npx`: over `install`'s engine (see lib/install/npm.mjs) */

import { run } from './lib/install/npm.mjs'

const { argv, exit } = globalThis.ecmaosSyscalls

exit(await run('npx', argv.slice(1)))
