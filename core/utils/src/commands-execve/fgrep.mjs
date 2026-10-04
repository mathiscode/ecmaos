/** `grep -F`: search for fixed strings. */

import { findProgram, run } from './lib/run.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const grep = findProgram('grep')
if (!grep) { writeAll(2, new TextEncoder().encode('fgrep: grep: command not found\n')); exit(127) }
exit((await run(grep, ['grep', '-F', ...argv.slice(1)])).status)
