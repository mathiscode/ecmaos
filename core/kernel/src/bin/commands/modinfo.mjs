/** Show what a kernel module says about itself, from its file or from the loaded module of that name. Does not run it. */

import { absolute, die, help, moduleCall } from './lib/module-call.mjs'

const usage = `Usage: modinfo FILE|NAME
Show the modinfo of a kernel module: a NAME.ko.mjs or NAME.ko.wasm file, a module that is loaded, or the name
or an alias of one installed in /lib/modules/RELEASE.

  --help  display this help and exit`

try {
  const args = globalThis.ecmaosSyscalls.argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) globalThis.ecmaosSyscalls.exit(help(usage))
  const unknown = args.find(arg => arg.startsWith('-'))
  if (unknown) globalThis.ecmaosSyscalls.exit(die('modinfo', `unrecognized option '${unknown}'`))
  if (!args.length) globalThis.ecmaosSyscalls.exit(die('modinfo', 'missing module'))
  let code = 0
  for (const target of args) code ||= await moduleCall({ action: 'info', target: /[/.]/.test(target) ? absolute(target) : target })
  globalThis.ecmaosSyscalls.exit(code)
} catch (error) {
  globalThis.ecmaosSyscalls.exit(die('modinfo', error instanceof Error ? error.message : String(error)))
}
