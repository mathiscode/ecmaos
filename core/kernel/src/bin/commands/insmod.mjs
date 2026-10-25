/** Load a kernel module: `insmod [-f] FILE [name=value ...]`. Needs CAP_SYS_MODULE (root). */

import { absolute, die, help, moduleCall } from './lib/module-call.mjs'

const usage = `Usage: insmod [-f] FILE [NAME=VALUE]...
Load the kernel module in FILE (a NAME.ko.mjs file) with the given parameters.

  -f, --force  load a module whose kernel_api does not match; the kernel is tainted F
  --help       display this help and exit`

try {
  const args = globalThis.ecmaosSyscalls.argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) globalThis.ecmaosSyscalls.exit(help(usage))
  const force = args.includes('-f') || args.includes('--force')
  const rest = args.filter(arg => arg !== '-f' && arg !== '--force')
  const unknown = rest.find(arg => arg.startsWith('-'))
  if (unknown) globalThis.ecmaosSyscalls.exit(die('insmod', `unrecognized option '${unknown}'`))
  if (!rest.length) globalThis.ecmaosSyscalls.exit(die('insmod', 'missing module file'))
  globalThis.ecmaosSyscalls.exit(await moduleCall({ action: 'load', path: absolute(rest[0]), params: rest.slice(1), force }))
} catch (error) {
  globalThis.ecmaosSyscalls.exit(die('insmod', error instanceof Error ? error.message : String(error)))
}
