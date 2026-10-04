/** Page through text a screen at a time. It is `less`, which does that and more. */

import { findProgram, run } from './lib/run.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const less = findProgram('less')
if (!less) { writeAll(2, new TextEncoder().encode('more: less: command not found\n')); exit(127) }
exit((await run(less, ['less', ...argv.slice(1)])).status)
