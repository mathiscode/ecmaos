/** `pip`: Python's package installer, on PyPI's wheels (see lib/pip/pip.mjs) */

import { run } from './lib/pip/pip.mjs'

const { argv, exit } = globalThis.ecmaosSyscalls

exit(await run('pip', argv.slice(1)))
