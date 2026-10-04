/** `grep -E`: search with an extended regular expression. */

import { findProgram, run } from './lib/run.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const grep = findProgram('grep')
if (!grep) { writeAll(2, new TextEncoder().encode('egrep: grep: command not found\n')); exit(127) }
exit((await run(grep, ['grep', '-E', ...argv.slice(1)])).status)
