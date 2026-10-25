/** Unload a kernel module: `rmmod [-f] NAME`. Needs CAP_SYS_MODULE (root). */

import { die, help, moduleCall } from './lib/module-call.mjs'

const usage = `Usage: rmmod [-f] NAME...
Unload kernel modules.

  -f, --force  unload a module that is still in use; the kernel is tainted F
  --help       display this help and exit`

try {
  const args = globalThis.ecmaosSyscalls.argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) globalThis.ecmaosSyscalls.exit(help(usage))
  const force = args.includes('-f') || args.includes('--force')
  const names = args.filter(arg => arg !== '-f' && arg !== '--force')
  const unknown = names.find(arg => arg.startsWith('-'))
  if (unknown) globalThis.ecmaosSyscalls.exit(die('rmmod', `unrecognized option '${unknown}'`))
  if (!names.length) globalThis.ecmaosSyscalls.exit(die('rmmod', 'missing module name'))
  let code = 0
  for (const name of names) code ||= await moduleCall({ action: 'unload', name: name.replace(/\.ko\.mjs$/, ''), force })
  globalThis.ecmaosSyscalls.exit(code)
} catch (error) {
  globalThis.ecmaosSyscalls.exit(die('rmmod', error instanceof Error ? error.message : String(error)))
}
