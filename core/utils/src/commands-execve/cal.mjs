/** `cal`: display a calendar, as util-linux's cal does. The layouts are in lib/cal-render.mjs. */

import { isTty } from './lib/tty.mjs'
import { renderCalendar } from './lib/cal-render.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()

try {
  const columns = Number(env.COLUMNS) || 80
  const result = renderCalendar(argv.slice(1), new Date(), columns, isTty(1) && env.NO_COLOR === undefined)
  if (result.out) writeAll(1, encoder.encode(result.out))
  if (result.err) writeAll(2, encoder.encode(result.err))
  exit(result.status)
} catch (error) {
  writeAll(2, encoder.encode(`cal: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
