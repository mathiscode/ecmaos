/** `finger`: see lib/finger-core.mjs */

import { fingerMain } from './lib/finger-core.mjs'

const { exit, writeAll } = globalThis.ecmaosSyscalls

try {
  exit(fingerMain('finger'))
} catch (error) {
  writeAll(2, new TextEncoder().encode(`finger: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
