/** `pinky`: see lib/finger-core.mjs */

import { fingerMain } from './lib/finger-core.mjs'

const { exit, writeAll } = globalThis.ecmaosSyscalls

try {
  exit(fingerMain('pinky'))
} catch (error) {
  writeAll(2, new TextEncoder().encode(`pinky: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
