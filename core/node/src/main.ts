import { Kernel } from '@ecmaos/kernel/kernel'

import { nodeHost } from './host.ts'
import { attachStdio } from './terminal.ts'

const argv = process.argv.slice(2)
const args = new Set(argv)
const value = (flag: string) => {
  const at = argv.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`))
  if (at === -1) return undefined
  return argv[at]!.includes('=') ? argv[at]!.slice(flag.length + 1) : argv[at + 1]
}

if (args.has('--help') || args.has('-h')) {
  console.log(`usage: ecmaos [--data DIR] [--ephemeral] [--quiet]

  --data DIR    keep the machine in DIR (default: $ECMAOS_DATA, else ./.ecmaos)
  --ephemeral   a root in memory; nothing is kept
  --quiet       skip the boot banner and messages`)
  process.exit(0)
}

const host = nodeHost({ data: value('--data'), ephemeral: args.has('--ephemeral') })
const kernel = new Kernel({
  credentials: { username: 'root', password: 'root' },
  host
})

await kernel.boot({ silent: args.has('--quiet') })
attachStdio(kernel, { stdin: process.stdin, stdout: process.stdout })
process.on('exit', () => host.close())
