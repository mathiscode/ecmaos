/** Write the dependency and alias files of the module directory: `depmod`. Needs CAP_SYS_MODULE (root). */

import { die, help, moduleCall } from './lib/module-call.mjs'

const usage = `Usage: depmod
Read every NAME.ko.mjs under /lib/modules/RELEASE and write modules.dep and modules.alias there,
which modprobe uses to load a module with what it needs.

  --help  display this help and exit`

try {
  const args = globalThis.ecmaosSyscalls.argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) globalThis.ecmaosSyscalls.exit(help(usage))
  if (args.length) globalThis.ecmaosSyscalls.exit(die('depmod', `unrecognized argument '${args[0]}'`))
  globalThis.ecmaosSyscalls.exit(await moduleCall({ action: 'depmod' }))
} catch (error) {
  globalThis.ecmaosSyscalls.exit(die('depmod', error instanceof Error ? error.message : String(error)))
}
