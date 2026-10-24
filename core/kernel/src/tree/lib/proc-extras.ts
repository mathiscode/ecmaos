/**
 * The parts of `/proc` that @zenfs/linux does not have and that `ps`, `lsof`, `vmstat`, `netstat` and their kind read:
 * `/proc/stat`, `/proc/loadavg`, `/proc/<pid>/stat` and `statm`, and `/proc/net/` (`tcp`, `tcp6`, `udp`, `udp6`, `unix`,
 * `dev`, `route`, `if_inet6`), laid out as Linux prints them. What the browser cannot measure is 0 rather than made up:
 * a WebAssembly program's CPU time and memory are not visible to the kernel. The sockets are the ones the kernel
 * itself keeps (the loopback listeners and the bound UDP ports); a connection that is only a pair of pipes has no row.
 */

import { ProcDir } from '@zenfs/linux/fs/procfs'
import type { Process } from '@zenfs/linux'
import { processes } from '@zenfs/linux'
import { getpgid, getsid } from './job-control.ts'

type Entry = { mode: number, show: () => string }
const file = (show: () => string): Entry => ({ mode: 0o444, show })

/** `USER_HZ`: the unit of every time in `/proc/stat` and `/proc/<pid>/stat` */
const Hz = 100

/** A socket the kernel holds, as `/proc/net` lists it */
export interface NetSocket {
  /** `inet` is IPv4, `inet6` IPv6 only, `inet46` an IPv6 socket that also takes IPv4 (`bind(::)`) */
  family: 'inet' | 'inet6' | 'inet46'
  port: number
  uid: number
  /** Names the socket in `/proc/<pid>/fd` as `socket:[inode]`; the same number every time for one socket */
  inode: number
}

export interface UnixSocket {
  path: string
  listening: boolean
  uid: number
  inode: number
}

export interface NetSource {
  /** Listening TCP sockets */
  tcp(): NetSocket[]
  udp(): NetSocket[]
  unix(): UnixSocket[]
}

let source: NetSource = { tcp: () => [], udp: () => [], unix: () => [] }

/** Where `/proc/net` gets its sockets; the syscall layer, which holds the tables, supplies it */
export function setNetSource(next: NetSource): void { source = next }

const inodes = new WeakMap<object, number>()
let nextInode = 30001

/** A stable inode number for a socket object, handed out the first time it is asked for */
export function socketInode(socket: object): number {
  let inode = inodes.get(socket)
  if (inode === undefined) { inode = nextInode++; inodes.set(socket, inode) }
  return inode
}

/** When the page started, in epoch milliseconds: the boot time of the machine */
const bootEpoch = Date.now() - performance.now()
const uptime = () => performance.now() / 1000
const cores = () => navigator.hardwareConcurrency || 1

/** Linux writes a clock tick count in whole numbers; a time since boot in ticks */
const ticks = (seconds: number) => Math.floor(seconds * Hz)

/** When each process joined the process table, in seconds since boot; one that was there before this module is from boot */
const started = new WeakMap<Process, number>()
const joinTable = processes.set.bind(processes)
processes.set = (pid, proc) => {
  if (!started.has(proc)) started.set(proc, uptime())
  return joinTable(pid, proc)
}
/** Never later than a tick ago, since `ps` divides by the time a process has run */
const startOf = (proc: Process) => Math.min(started.get(proc) ?? 0, Math.max(0, uptime() - 1 / Hz))

function showStat(): string {
  const idle = ticks(uptime())
  const lines = [`cpu  0 0 0 ${idle * cores()} 0 0 0 0 0 0`]
  for (let i = 0; i < cores(); i++) lines.push(`cpu${i} 0 0 0 ${idle} 0 0 0 0 0 0`)
  const live = [...processes.values()].filter(proc => proc.code === undefined)
  lines.push('intr 0', 'ctxt 0', `btime ${Math.floor(bootEpoch / 1000)}`, `processes ${Math.max(...processes.keys(), 0)}`,
    `procs_running ${Math.min(1, live.length)}`, 'procs_blocked 0')
  return lines.join('\n') + '\n'
}

function showLoadavg(): string {
  const all = [...processes.values()]
  const last = Math.max(...processes.keys(), 0)
  return `0.00 0.00 0.00 ${Math.min(1, all.length)}/${all.length} ${last}\n`
}

/** `tty_nr`: the controlling terminal's device number as `(major << 8) | minor`, or 0 with none */
function ttyNumber(proc: Process): number {
  const tty = proc.tty
  if (!tty) return 0
  const { major, minor } = tty.dev_t
  return ((major & 0xfff) << 8) | (minor & 0xff) | ((minor & ~0xff) << 12)
}

/** The 52 fields of `/proc/<pid>/stat`, from `pid (comm) state` on */
function showPidStat(proc: Process): string {
  const state = proc.zombie ? 'Z' : proc.stopped ? 'T' : 'S'
  const foreground = proc.tty?.foreground
  const fields = [
    proc.pid, `(${proc.comm || 'context'})`, state, proc.ppid, getpgid(proc), getsid(proc), ttyNumber(proc),
    foreground ? foreground.pid : -1, 0,
    0, 0, 0, 0,                 // minflt cminflt majflt cmajflt
    0, 0, 0, 0,                 // utime stime cutime cstime
    20, 0, 1, 0,                // priority nice num_threads itrealvalue
    ticks(startOf(proc)),
    0, 0, 0xffffffffffffffffn,  // vsize rss rsslim
    0, 0, 0, 0, 0,              // startcode endcode startstack kstkesp kstkeip
    0, 0, 0, 0,                 // signal blocked sigignore sigcatch
    0, 0, 0, 17, 0, 0, 0, 0, 0, // wchan nswap cnswap exit_signal processor rt_priority policy delayacct guest_time
    0, 0, 0, 0, 0, 0, 0, 0, proc.code ?? 0 // cguest_time start_data end_data start_brk arg_start arg_end env_start env_end exit_code
  ]
  return fields.join(' ') + '\n'
}

/** Both IPv4 and IPv6 addresses print as the hex of the bytes of each 32-bit word in the machine's (little endian) order */
const v4 = (a: number, b: number, c: number, d: number) => [d, c, b, a].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()
const LOCAL4 = v4(127, 0, 0, 1)
const ANY4 = v4(0, 0, 0, 0)
const ANY6 = '0'.repeat(32)
const LOCAL6 = '00000000000000000000000001000000'
const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0')

const header4 = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const header6 = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

function showInet(sockets: NetSocket[], six: boolean, state: string, trailer: string): string {
  const rows = sockets.filter(socket => six ? socket.family !== 'inet' : socket.family === 'inet')
  const any = six ? ANY6 : ANY4
  const header = (six ? header6 : header4) + (trailer ? ' ref pointer drops' : '')
  const lines = rows.map((socket, index) => {
    const local = six ? (socket.family === 'inet6' ? LOCAL6 : ANY6) : LOCAL4
    return `${String(index).padStart(4)}: ${local}:${hex(socket.port, 4)} ${any}:0000 ${state} 00000000:00000000 00:00000000 00000000 ${String(socket.uid).padStart(5)}        0 ${socket.inode}` +
      (trailer ? ' 2 0000000000000000 0' : ' 1 0000000000000000 100 0 0 10 0')
  })
  return [header, ...lines].join('\n') + '\n'
}

function showUnix(): string {
  const lines = source.unix().map(socket =>
    `0000000000000000: 00000002 00000000 ${socket.listening ? '00010000' : '00000000'} 0001 ${socket.listening ? '01' : '03'} ${socket.inode} ${socket.path}`)
  return ['Num       RefCount Protocol Flags    Type St Inode Path', ...lines].join('\n') + '\n'
}

function showDev(): string {
  return [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0'
  ].join('\n') + '\n'
}

const showRoute = () => 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
const showInet6 = () => '00000000000000000000000000000001 01 80 10 80       lo\n'

/** Adds the entries above to `/proc`. Call once, after procfs is loaded. */
export function registerProcExtras(root: ProcDir): void {
  root.children.set('stat', file(showStat))
  root.children.set('loadavg', file(showLoadavg))
  // paging and swap counters: the browser pages nothing in or out that the kernel could count
  root.children.set('vmstat', file(() => 'pgpgin 0\npgpgout 0\npswpin 0\npswpout 0\n'))
  root.children.set('net', new ProcDir({
    tcp: file(() => showInet(source.tcp(), false, '0A', '')),
    tcp6: file(() => showInet(source.tcp(), true, '0A', '')),
    udp: file(() => showInet(source.udp(), false, '07', 'udp')),
    udp6: file(() => showInet(source.udp(), true, '07', 'udp')),
    raw: file(() => header4 + '\n'),
    raw6: file(() => header6 + '\n'),
    unix: file(showUnix),
    dev: file(showDev),
    route: file(showRoute),
    if_inet6: file(showInet6)
  }))

  // `sysctl` walks /proc/sys: the numbers a program asks for with sysconf and the port range a connection is given
  const sys = root.lookup('sys')
  if (sys instanceof ProcDir) {
    const kernel = sys.lookup('kernel')
    if (kernel instanceof ProcDir) kernel.children.set('pid_max', file(() => '4194304\n'))
    sys.children.set('net', new ProcDir({
      ipv4: new ProcDir({ ip_local_port_range: file(() => '49152\t65535\n') })
    }))
  }

  // `/proc/<pid>` is built on each lookup, so the entries are added to what it returns
  const lookup = root.lookup.bind(root)
  root.lookup = (name: string) => {
    const entry = lookup(name)
    if (!entry || !/^\d+$/.test(name) || !(entry instanceof ProcDir)) return entry
    const proc = processes.get(Number(name))
    if (proc) {
      entry.children.set('stat', file(() => showPidStat(proc)))
      entry.children.set('statm', file(() => '0 0 0 0 0 0 0\n'))
      entry.children.set('cgroup', file(() => '0::/\n'))
    }
    return entry
  }
}
