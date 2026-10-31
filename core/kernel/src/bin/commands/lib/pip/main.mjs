/** The entry of the `pip` package: the command, named by what it was run as (`pip` or `pip3`) */

import { run } from './pip.mjs'

const { argv, exit } = globalThis.ecmaosSyscalls

exit(await run(String(argv[0]).split('/').pop() === 'pip3' ? 'pip3' : 'pip', argv.slice(1)))
