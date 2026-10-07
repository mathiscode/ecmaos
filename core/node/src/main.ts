import { spawn } from 'node:child_process'

import { Thread } from '@zenfs/linux'
import { Kernel } from '@ecmaos/kernel/kernel'

import { DefaultPort, startDaemon } from './ecmaosd.ts'
import type { Daemon } from './ecmaosd.ts'
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
  console.log(`usage: ecmaos [--data DIR] [--ephemeral] [--quiet] [--listen[=[HOST:]PORT]]

  --data DIR          keep the machine in DIR (default: $ECMAOS_DATA, else ./.ecmaos)
  --ephemeral         a root in memory; nothing is kept
  --quiet             skip the boot banner and messages

  --listen[=ADDR]     let other ecmaOS machines log in over a WebSocket (default 127.0.0.1:${DefaultPort}; loopback only)
  --allow-origin URL  a page allowed to connect from a browser (repeatable, replaces the defaults; * matches any text, as in http://localhost:*)
  --pair-user NAME    who a pairing code enrols (default: root)
  --no-pair           do not print a pairing code`)
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
let daemon: Daemon | undefined
let stopping = false

const finish = (code: number) => {
  void daemon?.close()
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
    void daemon?.close()
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

const listen = argv.find(arg => arg === '--listen' || arg.startsWith('--listen='))
if (listen) {
  const address = listen.includes('=') ? listen.slice('--listen='.length) : ''
  const split = address.lastIndexOf(':')
  const port = Number(split === -1 ? address : address.slice(split + 1))
  const origins = argv.flatMap((arg, index) => arg === '--allow-origin' && argv[index + 1] ? [argv[index + 1]!] : arg.startsWith('--allow-origin=') ? [arg.slice('--allow-origin='.length)] : [])
  const say = (text: string) => process.stderr.write(`\r\n${text}\r\n`)
  try {
    daemon = await startDaemon({
      kernel,
      dataDir: host.dataDir,
      flush: () => host.flush(),
      host: split > 0 ? address.slice(0, split) : undefined,
      port: address ? port : DefaultPort,
      origins: origins.length ? origins : undefined,
      pairUser: args.has('--no-pair') ? false : value('--pair-user'),
      log: text => { if (!args.has('--quiet')) say(`ecmaosd: ${text}`) }
    })
    say(`ecmaosd: listening on ${daemon.host}:${daemon.port}\r\necmaosd: host key ${daemon.fingerprint}`)
    if (daemon.pairing) say(`ecmaosd: pairing code for ${daemon.pairing.user}: ${daemon.pairing.code} (one use, 10 minutes)`)
  } catch (error) {
    say(`ecmaosd: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// TERM and HUP ask for an orderly stop; the first has the kernel halt, a second one ends the process outright
for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (stopping) return process.exit(128 + (signal === 'SIGTERM' ? 15 : 1))
    void kernel.stop('halt')
  })
}
