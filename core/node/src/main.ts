import { Kernel } from '@ecmaos/kernel/kernel'

import { nodeHost } from './host.ts'
import { attachStdio } from './terminal.ts'

const args = new Set(process.argv.slice(2))

if (args.has('--help') || args.has('-h')) {
  console.log('usage: ecmaos [--quiet]\n\n  --quiet   skip the boot banner and messages')
  process.exit(0)
}

const kernel = new Kernel({
  credentials: { username: 'root', password: 'root' },
  host: nodeHost()
})

await kernel.boot({ silent: args.has('--quiet') })
attachStdio(kernel, { stdin: process.stdin, stdout: process.stdout })
