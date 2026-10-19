import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { formatWithOptions } from 'node:util'

import { Thread } from '@zenfs/linux'
import { Kernel } from '@ecmaos/kernel/kernel'

import { DefaultPort, startDaemon } from './ecmaosd.ts'
import { Gateway, parsePorts, parseRule } from './gateway.ts'
import { DefaultSitePort, findSite, startSite } from './serve.ts'
import type { Site } from './serve.ts'
import { openDevice, parseDevice, parseDeviceList } from './devices.ts'
import { openExport, parseExport } from './exports.ts'
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
  console.log(`usage: ecmaos [--data DIR] [--ephemeral] [--quiet] [--login] [--listen[=[HOST:]PORT]] [--serve[=[HOST:]PORT] [--site DIR]]

  --data DIR          keep the machine in DIR (default: $ECMAOS_DATA, else ./.ecmaos)
  --ephemeral         a root in memory; nothing is kept
  --quiet             skip the boot banner and messages
  --login             ask for a user name and password on the console instead of logging in as root

  --listen[=ADDR]     let other ecmaOS machines log in over a WebSocket (default 127.0.0.1:${DefaultPort}; loopback only without --tls-cert)
  --serve[=ADDR]      serve the built site over http with the headers a page needs to run ecmaOS (default 127.0.0.1:${DefaultSitePort}).
                      Alone, it starts no machine; with --listen, both run
  --site DIR          the folder to serve (default: $ECMAOS_SITE, else the built kernel beside this package)
  --tls-cert FILE --tls-key FILE  serve wss:// (and https:// with --serve) with this certificate (PEM); needed to listen beyond loopback
  --allow-origin URL  a page allowed to connect from a browser (repeatable, replaces the defaults; * matches any text, as in http://localhost:*)
  --gateway           let machines that log in reach the network through this host (TCP); needs --listen. Closed by default:
                      this host, private networks and metadata addresses are never reached unless a rule names them
  --gateway-allow RULE  with any of these, only matching destinations are reachable; also what opens a private address
                      (repeatable). RULE is HOST[:PORTS] (HOST may use *), ADDRESS[/BITS][:PORTS], or [IPV6[/BITS]]:PORTS
  --gateway-deny RULE never reachable, whatever else says (repeatable)
  --gateway-user NAME  who may use it (default: root; repeatable)
  --gateway-max-flows N  most flows at once per login (default: 32)
  --gateway-listen PORTS  let a guest open these ports on this host (inbound forwarding, e.g. 8000-8099); off by default
  --gateway-listen-allow LIST  only these clients (addresses or networks, comma separated) may connect to an opened port
  --gateway-listen-address ADDR  where they are opened (default 127.0.0.1; a wider address also needs --gateway-public)
  --gateway-public    allow --gateway on an address beyond loopback (it then proxies for anyone who can log in; use TLS)
  --pair-user NAME    who a pairing code enrols (default: root)
  --no-pair           do not print a pairing code
  --export [NAME=]DIR[:rw]  offer a host directory to machines that log in (read-only unless :rw; repeatable)
  --device NAME=SPEC[:rw]   offer a host device to root on machines that log in; SPEC is file:PATH (a serial port, FIFO or
                            file) or loopback; read-only unless :rw or :wo (write-only); repeatable. More are read from
                            $ECMAOS_DATA/ecmaosd/devices, one per line`)
  process.exit(0)
}

let site: Site | undefined

// `--serve` hands out the built site; on its own it starts no machine
const serve = argv.find(arg => arg === '--serve' || arg.startsWith('--serve='))
if (serve) {
  const address = serve.includes('=') ? serve.slice('--serve='.length) : ''
  const split = address.lastIndexOf(':')
  const port = split === -1 ? address : address.slice(split + 1)
  const certFile = value('--tls-cert')
  const keyFile = value('--tls-key')
  try {
    if (!!certFile !== !!keyFile) throw new Error('--tls-cert and --tls-key go together')
    site = await startSite({
      root: findSite(value('--site')),
      host: split > 0 ? address.slice(0, split) : undefined,
      port: port ? Number(port) : DefaultSitePort,
      tls: certFile && keyFile ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined
    })
    console.error(`ecmaos: serving ${site.root} on ${certFile ? 'https' : 'http'}://${site.host}:${site.port}`)
  } catch (error) {
    console.error(`ecmaos: --serve: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  if (!argv.some(arg => arg === '--listen' || arg.startsWith('--listen='))) {
    const stop = () => { void site!.close().then(() => process.exit(0)) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await new Promise<void>(() => {})
  }
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
  void site?.close()
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
    void site?.close()
    void daemon?.close()
    stopThreads()
    terminal.detach?.()
    host.close()
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: process.env })
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 0)))
  }
})

const kernel = new Kernel({
  // `--login` leaves the console at a login prompt (`/sbin/getty` under init) instead of logging root in
  credentials: args.has('--login') ? undefined : { username: 'root', password: 'root' },
  host
})

// --quiet keeps the kernel's chatter off the console and still says what went wrong (warnings and errors); every line
// still goes to /var/log/kernel.log
if (args.has('--quiet')) (kernel.log.settings.overwrite ??= {}).transportFormatted = (meta, logArgs, errors, logMeta) => {
  if ((logMeta?.logLevelId ?? 0) < 4) return
  console.log(meta + formatWithOptions(kernel.log.settings.prettyInspectOptions, ...logArgs) + (errors.length ? `\n${errors.join('\n')}` : ''))
}

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
    const exported = await Promise.all(argv.flatMap((arg, index) => arg === '--export' && argv[index + 1] ? [argv[index + 1]!] : arg.startsWith('--export=') ? [arg.slice('--export='.length)] : []).map(async text => {
      const spec = parseExport(text)
      return { name: spec.name, readOnly: spec.readOnly, backend: await openExport(spec) }
    }))
    const devices = argv.flatMap((arg, index) => arg === '--device' && argv[index + 1] ? [argv[index + 1]!] : arg.startsWith('--device=') ? [arg.slice('--device='.length)] : []).map(parseDevice)
    if (host.dataDir) {
      try { devices.push(...parseDeviceList(readFileSync(path.join(host.dataDir, 'ecmaosd', 'devices'), 'utf8'))) } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error
      }
    }
    const certFile = value('--tls-cert')
    const keyFile = value('--tls-key')
    if (!!certFile !== !!keyFile) throw new Error('--tls-cert and --tls-key go together')
    const all = (flag: string) => argv.flatMap((arg, index) => arg === flag && argv[index + 1] ? [argv[index + 1]!] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : [])
    const gatewayHost = split > 0 ? address.slice(0, split) : undefined
    const loopbackOnly = !gatewayHost || gatewayHost === 'localhost' || gatewayHost === '127.0.0.1' || gatewayHost === '::1'
    if (args.has('--gateway') && !loopbackOnly && !args.has('--gateway-public')) throw new Error('--gateway on an address beyond loopback also needs --gateway-public: it lets everyone who can log in use this host to reach the network')
    const listenPorts = value('--gateway-listen')
    if (listenPorts && !args.has('--gateway')) throw new Error('--gateway-listen needs --gateway')
    const listenAddress = value('--gateway-listen-address')
    if (listenAddress && !listenPorts) throw new Error('--gateway-listen-address needs --gateway-listen')
    if (listenAddress && !['127.0.0.1', 'localhost', '::1'].includes(listenAddress) && !args.has('--gateway-public')) throw new Error(`--gateway-listen-address ${listenAddress} exposes guest ports beyond this host, which also needs --gateway-public`)
    const listenAllow = value('--gateway-listen-allow')
    if (listenAllow && !listenPorts) throw new Error('--gateway-listen-allow needs --gateway-listen')
    const allowed = listenAllow ? listenAllow.split(',').map(parseRule) : undefined
    if (allowed?.some(rule => !rule.addresses || rule.ports)) throw new Error('--gateway-listen-allow takes addresses or networks (10.0.0.0/8), not names or ports')
    const gateway = args.has('--gateway') ? new Gateway({
      listen: listenPorts ? { ports: parsePorts(listenPorts), address: listenAddress, allow: allowed } : undefined,
      users: all('--gateway-user').length ? all('--gateway-user') : undefined,
      allow: all('--gateway-allow').map(parseRule),
      deny: all('--gateway-deny').map(parseRule),
      maxFlows: value('--gateway-max-flows') ? Number(value('--gateway-max-flows')) : undefined,
      // the audit trail is not a message that --quiet may drop
      log: text => say(`gateway: ${text}`)
    }) : undefined
    daemon = await startDaemon({
      gateway,
      tls: certFile && keyFile ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined,
      devices: devices.map(openDevice),
      exports: exported,
      kernel,
      display: host.display.renderer,
      dataDir: host.dataDir,
      flush: () => host.flush(),
      host: split > 0 ? address.slice(0, split) : undefined,
      port: address ? port : DefaultPort,
      origins: origins.length ? origins : undefined,
      pairUser: args.has('--no-pair') ? false : value('--pair-user'),
      log: text => { if (!args.has('--quiet')) say(`ecmaosd: ${text}`) }
    })
    say(`ecmaosd: listening on ${daemon.host}:${daemon.port}${certFile ? ' (TLS)' : ''}\r\necmaosd: host key ${daemon.fingerprint}`)
    if (gateway) say(`gateway: on for ${gateway.users.join(', ')}${listenPorts ? `; guests may open ports ${listenPorts} on ${listenAddress ?? '127.0.0.1'}` : ''}`)
    for (const shared of exported) say(`ecmaosd: exporting ${shared.name}${shared.readOnly ? ' (read-only)' : ' (read-write)'}`)
    for (const device of devices) say(`ecmaosd: offering device ${device.name} (${device.kind}, ${device.read && device.write ? 'read-write' : device.write ? 'write-only' : 'read-only'})`)
    if (site) say(`ecmaosd: screen page: ${certFile ? 'https' : 'http'}://${site.host}:${site.port}/?screen=${daemon.host}:${daemon.port}`)
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
