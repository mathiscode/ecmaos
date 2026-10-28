/**
 * More of `/sys` for the tools that read it: `class/net/lo` (what `/proc/net/dev` lists), `class/power_supply` (the
 * battery and whether the machine is on mains, from the browser's Battery API where it has one), a root `fs/cgroup`
 * and the CPU masks under `devices/system/cpu`.
 *
 * `fs/cgroup` is nominal. It is the root of a cgroup tree with no controllers and no children, the same shape
 * `/proc/<pid>/cgroup` (`0::/`) already reports: every process is in it, and nothing can be limited.
 */

import { KObject, kobj_create, sysfs_create_link, sysfs_lookup } from '@zenfs/linux'
import { processes } from '@zenfs/linux'

const cores = () => navigator.hardwareConcurrency || 1

/** The directory at `path`, made (with its parents) when it is not there */
function dir(path: string): KObject {
  const have = sysfs_lookup(path)
  if (have instanceof KObject) return have
  const parent = path.slice(0, path.lastIndexOf('/'))
  if (parent) dir(parent)
  return kobj_create(path)
}

/** Adds a read-only attribute that shows `value()` on each read; the second boot of a page keeps the first's */
function attr(kobject: KObject, name: string, value: () => string | number): void {
  if (kobject.attributes.has(name)) return
  kobject.create_attribute(name, () => `${value()}\n`)
}

const link = (parent: KObject, target: KObject) => { if (!parent.lookup(target.name)) sysfs_create_link(parent, target) }

function network(): void {
  const lo = dir('/devices/virtual/net/lo')
  const fixed: Record<string, string | number> = {
    addr_len: 6, address: '00:00:00:00:00:00', broadcast: '00:00:00:00:00:00', carrier: 1, carrier_changes: 0, dormant: 0,
    flags: '0x9', ifalias: '', ifindex: 1, iflink: 1, link_mode: 0, mtu: 65536, operstate: 'unknown', proto_down: 0,
    tx_queue_len: 1000, type: 772
  }
  for (const [name, value] of Object.entries(fixed)) attr(lo, name, () => value)
  // the counters /proc/net/dev prints: the loopback's traffic is not counted
  const statistics = dir('/devices/virtual/net/lo/statistics')
  for (const name of ['rx_bytes', 'rx_packets', 'rx_errors', 'rx_dropped', 'tx_bytes', 'tx_packets', 'tx_errors', 'tx_dropped', 'collisions', 'multicast']) attr(statistics, name, () => 0)
  link(dir('/class/net'), lo)
}

interface BatteryManager extends EventTarget { charging: boolean, level: number }
let battery: BatteryManager | undefined

function power(): void {
  const getBattery = (navigator as unknown as { getBattery?: () => Promise<BatteryManager> }).getBattery
  if (!getBattery) return
  void getBattery.call(navigator).then(manager => {
    battery = manager
    const supply = dir('/class/power_supply')
    const bat = dir('/devices/virtual/power_supply/BAT0')
    const percent = () => Math.round((battery?.level ?? 0) * 100)
    attr(bat, 'type', () => 'Battery')
    attr(bat, 'present', () => 1)
    attr(bat, 'capacity', percent)
    attr(bat, 'status', () => !battery?.charging ? 'Discharging' : percent() >= 100 ? 'Full' : 'Charging')
    attr(bat, 'capacity_level', () => percent() >= 100 ? 'Full' : percent() <= 5 ? 'Critical' : percent() <= 15 ? 'Low' : 'Normal')
    link(supply, bat)
    const ac = dir('/devices/virtual/power_supply/AC')
    attr(ac, 'type', () => 'Mains')
    attr(ac, 'online', () => battery?.charging ? 1 : 0)
    link(supply, ac)
  }).catch(() => { /* a browser that refuses the Battery API has no supply to show */ })
}

function cgroup(): void {
  const root = dir('/fs/cgroup')
  attr(root, 'cgroup.controllers', () => '')
  attr(root, 'cgroup.subtree_control', () => '')
  attr(root, 'cgroup.max.depth', () => 'max')
  attr(root, 'cgroup.max.descendants', () => 'max')
  attr(root, 'cgroup.stat', () => 'nr_descendants 0\nnr_dying_descendants 0')
  const pids = () => [...processes.values()].filter(proc => proc.code === undefined).map(proc => proc.pid).sort((a, b) => a - b).join('\n')
  attr(root, 'cgroup.procs', pids)
  attr(root, 'cgroup.threads', pids)
}

function processors(): void {
  const cpu = dir('/devices/system/cpu')
  const range = () => cores() > 1 ? `0-${cores() - 1}` : '0'
  for (const name of ['online', 'possible', 'present']) attr(cpu, name, range)
  attr(cpu, 'offline', () => '')
  attr(cpu, 'kernel_max', () => cores() - 1)
}

/** Adds the entries above to `/sys`. Safe to call again: what is already there is kept. */
export function registerSysDepth(): void {
  network()
  power()
  cgroup()
  processors()
}
