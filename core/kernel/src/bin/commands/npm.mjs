/** `npm`: over `install`'s engine (see lib/install/npm.mjs) */

import { run } from './lib/install/npm.mjs'

const { argv, exit } = globalThis.ecmaosSyscalls

exit(await run('npm', argv.slice(1)))
