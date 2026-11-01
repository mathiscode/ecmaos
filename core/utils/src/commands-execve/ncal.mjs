/** `ncal`: the calendar with the days laid out vertically, a week to a column: `cal -v`, with ncal's option spelling (`-M` for Monday first). */

import { isTty } from './lib/tty.mjs'
import { renderCalendar } from './lib/cal-render.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()

try {
  // ncal's -M is cal's -m; -b (the old layout), -C and -h (no highlight) change nothing here
  const args = argv.slice(1).flatMap(arg => (arg === '-M' ? ['-m'] : ['-b', '-C', '-h'].includes(arg) ? [] : [arg]))
  const columns = Number(env.COLUMNS) || 80
  const result = renderCalendar(['-v', ...args], new Date(), columns, isTty(1) && env.NO_COLOR === undefined)
  if (result.out) writeAll(1, encoder.encode(result.out))
  if (result.err) writeAll(2, encoder.encode(result.err.replace(/\bcal\b/g, 'ncal')))
  exit(result.status)
} catch (error) {
  writeAll(2, encoder.encode(`ncal: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
