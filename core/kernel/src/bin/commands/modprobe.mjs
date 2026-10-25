/** Load a kernel module by name with what it needs, or unload it: `modprobe [-nvr] NAME [name=value ...]`. Needs CAP_SYS_MODULE (root). */

import { die, help, moduleCall } from './lib/module-call.mjs'

const usage = `Usage: modprobe [-n] [-v] [-r] [--ignore-install] NAME [NAME=VALUE]...
Load the module NAME (or an alias of one) from /lib/modules/RELEASE with the modules it depends on, using the options
of /etc/modprobe.d. With -r, unload it and the modules it needed that nothing else holds.

  -n, --dry-run         print what would be done and do nothing
  -v, --verbose         print what is done
  -r, --remove          unload instead of load
  --ignore-install      do not run the install or remove command of modprobe.d for NAME
  --help                display this help and exit`

try {
  const args = globalThis.ecmaosSyscalls.argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) globalThis.ecmaosSyscalls.exit(help(usage))
  const flags = { n: false, v: false, r: false, ignore: false }
  const rest = []
  for (const arg of args) {
    if (arg === '--dry-run') flags.n = true
    else if (arg === '--verbose') flags.v = true
    else if (arg === '--remove') flags.r = true
    else if (arg === '--ignore-install' || arg === '--ignore-remove') flags.ignore = true
    else if (/^-[nvr]+$/.test(arg)) for (const letter of arg.slice(1)) flags[letter] = true
    else if (arg.startsWith('-')) globalThis.ecmaosSyscalls.exit(die('modprobe', `unrecognized option '${arg}'`))
    else rest.push(arg)
  }
  if (!rest.length) globalThis.ecmaosSyscalls.exit(die('modprobe', 'missing module name'))
  globalThis.ecmaosSyscalls.exit(await moduleCall({
    action: 'probe', name: rest[0], remove: flags.r, dryRun: flags.n, verbose: flags.v, ignoreCommands: flags.ignore, params: rest.slice(1)
  }))
} catch (error) {
  globalThis.ecmaosSyscalls.exit(die('modprobe', error instanceof Error ? error.message : String(error)))
}
