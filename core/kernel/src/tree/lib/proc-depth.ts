/**
 * More of `/proc` for the tools that read it: `limits`, `mountinfo`, `maps`, `smaps`, `io`, `ns/`, `oom_score`, `oom_score_adj`,
 * `wchan` and `loginuid` under each process; `swaps`, `diskstats`, `interrupts`, `locks` and `cgroups` at the top; and the `sysctl` keys
 * programs ask for (`kernel/random`, `vm`, `fs`, `net/core`). Like `proc-extras.ts`, what the browser cannot measure reads 0.
 * Where the machine has nothing of a kind, the file is there and empty of rows: no swap, no interrupts, no controllers.
 *
 * Two things are the same for every process because there is only one of each. `limits` shows what a new process starts with:
 * a WebAssembly program's `setrlimit` is its own and the kernel does not see it. `ns/` names the initial namespaces, since
 * there are no others (`unshare` says so). `maps` and `smaps` are empty because a program's linear memory is not an address
 * space the kernel maps.
 */

import { ProcDir, ProcLink } from '@zenfs/linux/fs/procfs'
import type { ProcFile } from '@zenfs/linux/fs/procfs'
import { current, processes } from '@zenfs/linux'
import { leaderOf } from './wali-threads.ts'
import { showLocks } from './record-locks.ts'

const file = (show: () => string): ProcFile => ({ mode: 0o444, show })
const cores = () => navigator.hardwareConcurrency || 1

/** The limits `wali-host.mjs` starts a process with (descriptors have Linux's 1024 and a hard limit of what the host keeps flags for) */
const LIMITS: Array<[name: string, soft: string, hard: string, unit: string]> = [
  ['Max cpu time', 'unlimited', 'unlimited', 'seconds'],
  ['Max file size', 'unlimited', 'unlimited', 'bytes'],
  ['Max data size', 'unlimited', 'unlimited', 'bytes'],
  ['Max stack size', '8388608', 'unlimited', 'bytes'],
  ['Max core file size', '0', 'unlimited', 'bytes'],
  ['Max resident set', 'unlimited', 'unlimited', 'bytes'],
  ['Max processes', 'unlimited', 'unlimited', 'processes'],
  ['Max open files', '1024', '65536', 'files'],
  ['Max locked memory', '8388608', '8388608', 'bytes'],
  ['Max address space', 'unlimited', 'unlimited', 'bytes'],
  ['Max file locks', 'unlimited', 'unlimited', 'locks'],
  ['Max pending signals', 'unlimited', 'unlimited', 'signals'],
  ['Max msgqueue size', '819200', '819200', 'bytes'],
  ['Max nice priority', '0', '0', ''],
  ['Max realtime priority', '0', '0', ''],
  ['Max realtime timeout', 'unlimited', 'unlimited', 'us']
]

const row = (name: string, soft: string, hard: string, unit: string) => `${name.padEnd(25)} ${soft.padEnd(20)} ${hard.padEnd(20)} ${unit.padEnd(10)}\n`
const showLimits = () => row('Limit', 'Soft Limit', 'Hard Limit', 'Units') + LIMITS.map(limit => row(...limit)).join('')

/** The inode numbers Linux gives the initial namespaces */
const NAMESPACES: Record<string, number> = {
  cgroup: 4026531835, ipc: 4026531839, mnt: 4026531841, net: 4026531840, pid: 4026531836, time: 4026531834, user: 4026531837, uts: 4026531838
}
const namespaces = () => new ProcDir(Object.fromEntries(Object.entries(NAMESPACES).map(([name, inode]) => [name, new ProcLink(() => `${name}:[${inode}]`)])))

/**
 * `/proc/<pid>/mountinfo` from the lines of `/proc/mounts`: an id for each mount, the mount it sits in, a device number
 * of the anonymous kind (`0:N`) and the options split into the mount's and the file system's.
 */
export function mountinfo(mounts: string): string {
  const table = mounts.split('\n').filter(Boolean).map(text => {
    const [source = 'none', target = '/', type = 'none', options = 'rw'] = text.split(' ')
    return { source, target, type, options }
  })
  const parentOf = (index: number) => {
    const { target } = table[index]!
    let best = index
    let length = -1
    table.forEach((other, at) => {
      if (at === index) return
      const prefix = other.target === '/' ? '' : other.target
      if ((target === other.target || target.startsWith(prefix + '/')) && other.target.length >= length && at < index) { best = at; length = other.target.length }
    })
    return best
  }
  return table.map((mount, index) => {
    const access = mount.options.split(',')[0] === 'ro' ? 'ro' : 'rw'
    return `${22 + index} ${22 + parentOf(index)} 0:${30 + index} / ${mount.target} ${mount.options} - ${mount.type} ${mount.source} ${access}\n`
  }).join('')
}

/** `/proc/diskstats` from the block devices `/proc/partitions` lists: every counter 0 */
function diskstats(partitions: string): string {
  return partitions.split('\n').slice(2).filter(Boolean).map(text => {
    const [major, minor, , name] = text.trim().split(/\s+/)
    return `${major!.padStart(4)} ${minor!.padStart(7)} ${name} ${'0 '.repeat(16)}0\n`
  }).join('')
}

const bootId = crypto.randomUUID()

function sysctl(root: ProcDir): void {
  const sys = root.lookup('sys')
  if (!(sys instanceof ProcDir)) return
  const dir = (name: string) => {
    const have = sys.lookup(name)
    if (have instanceof ProcDir) return have
    const made = new ProcDir({})
    sys.children.set(name, made)
    return made
  }
  const text = (value: string) => file(() => value + '\n')

  const kernel = dir('kernel')
  kernel.children.set('threads-max', text('126976'))
  kernel.children.set('ngroups_max', text('65536'))
  kernel.children.set('overflowuid', text('65534'))
  kernel.children.set('overflowgid', text('65534'))
  kernel.children.set('panic', text('0'))
  kernel.children.set('printk', text('4\t4\t1\t7'))
  kernel.children.set('random', new ProcDir({
    boot_id: text(bootId),
    // a new one on each read, as Linux gives
    uuid: file(() => crypto.randomUUID() + '\n'),
    entropy_avail: text('256'),
    poolsize: text('256')
  }))

  const vm = dir('vm')
  vm.children.set('swappiness', text('60'))
  vm.children.set('overcommit_memory', text('0'))
  vm.children.set('max_map_count', text('65530'))

  dir('fs').children.set('nr_open', text('65536'))

  dir('net').children.set('core', new ProcDir({ somaxconn: text('4096') }))
}

/** Adds the entries above to `/proc`. Call once, after `registerProcExtras`. */
export function registerProcDepth(root: ProcDir): void {
  const content = (name: string) => {
    const entry = root.children.get(name) as ProcFile | undefined
    return entry && 'show' in entry ? entry.show() : ''
  }

  root.children.set('swaps', file(() => 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n'))
  root.children.set('diskstats', file(() => diskstats(content('partitions'))))
  root.children.set('interrupts', file(() => {
    const columns = Array.from({ length: cores() }, (_, cpu) => `CPU${cpu}`).join(' '.repeat(7))
    return `${' '.repeat(11)}${columns}\nERR: ${'0'.padStart(10)}\nMIS: ${'0'.padStart(10)}\n`
  }))
  root.children.set('locks', file(showLocks))
  // /proc/self is the process, as on Linux, not the thread asking: a thread of a WALI program is a process of the
  // kernel's with an id of its own, and its own entry lists none of the descriptors the program's threads share
  const self = root.children.get('self') as ProcLink | undefined
  if (self) root.children.set('self', new ProcLink(() => (current ? String(leaderOf(current).pid) : self.target())))
  root.children.set('cgroups', file(() => '#subsys_name\thierarchy\tnum_cgroups\tenabled\n'))
  sysctl(root)

  const ns = namespaces()
  const entries: Record<string, ProcFile | ProcDir> = {
    limits: file(showLimits),
    maps: file(() => ''),
    smaps: file(() => ''),
    io: file(() => ['rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes', 'cancelled_write_bytes'].map(name => `${name}: 0\n`).join('')),
    ns,
    oom_score: file(() => '0\n'),
    oom_score_adj: file(() => '0\n'),
    // Linux prints these two with no newline
    wchan: file(() => '0'),
    loginuid: file(() => '4294967295')
  }

  const lookup = root.lookup.bind(root)
  root.lookup = (name: string) => {
    const entry = lookup(name)
    if (!entry || !/^\d+$/.test(name) || !(entry instanceof ProcDir) || !processes.get(Number(name))) return entry
    for (const [child, value] of Object.entries(entries)) entry.children.set(child, value)
    entry.children.set('mountinfo', file(() => mountinfo(content('mounts'))))
    // `task/<pid>` was copied from `/proc/<pid>` before these were added
    const task = entry.children.get('task')
    const main = task instanceof ProcDir ? task.children.get(name) : undefined
    if (main instanceof ProcDir) for (const [child, value] of entry.children) if (child !== 'task' && !main.children.has(child)) main.children.set(child, value)
    return entry
  }
}
