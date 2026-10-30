/** Uninstall packages: `uninstall <package-name>[@version]...`, which is `install remove`. */

import { Database, scopeOf } from './lib/install/db.mjs'
import { Engine } from './lib/install/engine.mjs'

const { argv, exit, write, geteuid } = globalThis.ecmaosSyscalls

const usage = `Usage: uninstall [-g|--user] [--autoremove] <package-name>[@version]...
Uninstall packages. If no version is specified, all versions are uninstalled. A package another installed package
still depends on is kept as a dependency; 'install autoremove' removes it once nothing needs it.`

async function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }
  const options = {
    global: args.includes('-g') || args.includes('--global'),
    user: args.includes('--user'),
    autoremove: args.includes('--autoremove')
  }
  const specs = args.filter(arg => !arg.startsWith('-'))
  if (!specs.length) {
    write(2, new TextEncoder().encode('Usage: uninstall <package-name>[@version]\n'))
    return 1
  }
  if (options.global && geteuid() !== 0) throw new Error('removing a system package needs root (sudo uninstall -g ...)')
  const scope = scopeOf(options)
  const engine = new Engine({ scope, db: new Database(scope), options })
  return await engine.remove(specs, { autoremove: options.autoremove })
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`uninstall: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
