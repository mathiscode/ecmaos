import { spawn } from 'node:child_process'

import { Thread } from '@zenfs/linux'
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

// How long a stopped kernel gets to let go of the process (workers, ports) before it is ended
const ExitGrace = 3000

// Every worker thread the kernel starts. A process that already exited can leave its thread behind (it is out of the
// process table by then), and each one holds the Node process open, so they are tracked here and stopped together.
const threads = new Set<Thread>()
const start = Thread.prototype.start
let threadsStopped = false
Thread.prototype.start = async function (this: Thread, ...args: Parameters<Thread['start']>) {
  threads.add(this)
  await start.apply(this, args)
  // init respawns `crond` the moment it is killed; once the machine is going down, nothing may start again
  if (threadsStopped) this.kill()
}
const stopThreads = () => { threadsStopped = true; for (const thread of threads) thread.kill() }

const terminal: { detach?: () => void } = {}
let stopping = false

const finish = (code: number) => {
  stopThreads()
  terminal.detach?.()
  host.close()
  process.exitCode = code
  // The event loop drains by itself when everything was released; if a worker or port is still holding on, end it
  setTimeout(() => process.exit(code), ExitGrace).unref()
}

const host = nodeHost({
  data: value('--data'),
  ephemeral: args.has('--ephemeral'),
  onStop(action) {
    if (stopping) return
    stopping = true
    if (action !== 'reboot') return finish(0)
    // A reboot starts the same command again: a new process is a clean kernel, with none of the old one's mounts or workers
    stopThreads()
    terminal.detach?.()
    host.close()
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: process.env })
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 0)))
  }
})

const kernel = new Kernel({
  credentials: { username: 'root', password: 'root' },
  host
})

await kernel.boot({ silent: args.has('--quiet') })
terminal.detach = attachStdio(kernel, { stdin: process.stdin, stdout: process.stdout })

// TERM and HUP ask for an orderly stop; the first has the kernel halt, a second one ends the process outright
for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (stopping) return process.exit(128 + (signal === 'SIGTERM' ? 15 : 1))
    void kernel.stop('halt')
  })
}
