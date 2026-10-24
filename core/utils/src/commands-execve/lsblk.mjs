/** List block devices, read from `/sys/block` and `/proc/mounts`: the disks and partitions the kernel has, as a tree. */

import { getopt } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll, readdir } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: lsblk [OPTIONS]
List block devices.

  -a, --all          also list devices with no size
  -b, --bytes        sizes in bytes
  -d, --nodeps       only the disks, not their partitions
  -f, --fs           filesystem information: NAME,FSTYPE,MOUNTPOINTS
  -J, --json         JSON output
  -l, --list         a list, not a tree
  -n, --noheadings   no header line
  -o, --output LIST  columns to show (see below)
  -P, --pairs        KEY="value" pairs
  -p, --paths        full device paths in NAME
  -r, --raw          raw output, no padding
  -h, --help         display this help and exit

Columns: NAME KNAME PATH MAJ:MIN MAJ MIN RM SIZE RO TYPE MOUNTPOINT MOUNTPOINTS FSTYPE
The default is NAME,MAJ:MIN,RM,SIZE,RO,TYPE,MOUNTPOINTS.

Reads /sys/block (the disks, and their partitions beneath them) and /proc/mounts. A machine with no block devices has an
empty listing; the folders and files ecmaOS mounts are not block devices.`

const defaults = ['NAME', 'MAJ:MIN', 'RM', 'SIZE', 'RO', 'TYPE', 'MOUNTPOINTS']
const columns = {
  NAME: { right: false }, KNAME: { right: false }, PATH: { right: false }, 'MAJ:MIN': { right: false }, MAJ: { right: true }, MIN: { right: true },
  RM: { right: true }, SIZE: { right: true }, RO: { right: true }, TYPE: { right: false }, MOUNTPOINT: { right: false }, MOUNTPOINTS: { right: false }, FSTYPE: { right: false }
}

const names = path => {
  try { return readdir(path).map(entry => (typeof entry === 'string' ? entry : entry.name)).filter(name => name !== '.' && name !== '..').sort() } catch { return [] }
}
const text = path => { try { return readTextFile(path).trim() } catch { return '' } }

/** `lsblk`'s human sizes: binary units, one decimal that is dropped when it is zero (1.5G, 512M, 4K) */
function human(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T', 'P', 'E']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${units[unit]}`
}

function mounts() {
  const byDevice = new Map()
  for (const line of text('/proc/mounts').split('\n')) {
    const [source, target, type] = line.split(' ')
    if (!source?.startsWith('/dev/')) continue
    const entry = byDevice.get(source.slice(5)) ?? { targets: [], type }
    entry.targets.push(target.replace(/\\040/g, ' '))
    byDevice.set(source.slice(5), entry)
  }
  return byDevice
}

function kind(name, partition) {
  if (partition) return 'part'
  if (name.startsWith('loop')) return 'loop'
  if (/^sr\d/.test(name)) return 'rom'
  return 'disk'
}

/** The disks in /sys/block, each with its partitions (the directories under it that have a `partition` file) */
function devices(mounted) {
  const describe = (name, dir, partition) => {
    const [major, minor] = text(`${dir}/dev`).split(':')
    const used = mounted.get(name)
    return {
      name, partition, children: [],
      maj: major ?? '0', min: minor ?? '0',
      rm: text(`${dir}/removable`) || '0', ro: text(`${dir}/ro`) || '0',
      bytes: (Number(text(`${dir}/size`)) || 0) * 512,
      type: kind(name, partition),
      mountpoints: used?.targets ?? [], fstype: used?.type ?? ''
    }
  }
  return names('/sys/block').map(name => {
    const disk = describe(name, `/sys/block/${name}`, false)
    for (const part of names(`/sys/block/${name}`)) {
      if (text(`/sys/block/${name}/${part}/partition`)) disk.children.push(describe(part, `/sys/block/${name}/${part}`, true))
    }
    return disk
  })
}

function main() {
  const parsed = getopt(argv.slice(1), {
    short: 'abdfJlno:Pprh',
    long: { all: 'a', bytes: 'b', nodeps: 'd', fs: 'f', json: 'J', list: 'l', noheadings: 'n', output: { key: 'o', arg: 'required' }, pairs: 'P', paths: 'p', raw: 'r', help: 'h' }
  })
  if (parsed.error) { err(`lsblk: ${parsed.error}`); err("Try 'lsblk --help' for more information."); return 1 }
  const flags = new Map(parsed.options)
  if (flags.has('h')) { out(usage + '\n'); return 0 }
  if (parsed.operands.length) { err('lsblk: device arguments are not supported'); return 1 }
  if (!names('/sys/block').length && !names('/sys').length) { err('lsblk: failed to access sysfs directory: /sys/block'); return 1 }

  let wanted = flags.has('f') ? ['NAME', 'FSTYPE', 'MOUNTPOINTS'] : defaults
  if (typeof flags.get('o') === 'string') {
    wanted = flags.get('o').split(',').map(column => column.toUpperCase()).filter(Boolean)
    const unknown = wanted.find(column => !(column in columns))
    if (unknown) { err(`lsblk: unknown column: ${unknown}`); return 1 }
  }

  const rows = []
  const walk = (list, depth, last) => {
    list.forEach((device, index) => {
      if (!flags.has('a') && device.bytes === 0 && !device.children.length) return
      const final = index === list.length - 1
      const branch = flags.has('l') || flags.has('r') || flags.has('J') || flags.has('P') ? '' : depth === 0 ? '' : `${last}${final ? '└─' : '├─'}`
      rows.push({ device, branch })
      if (!flags.has('d')) walk(device.children, depth + 1, depth === 0 ? '' : last + (final ? '  ' : '│ '))
    })
  }
  walk(devices(mounts()), 0, '')

  const path = device => `/dev/${device.name}`
  const value = (row, column) => {
    const { device } = row
    switch (column) {
      case 'NAME': return row.branch + (flags.has('p') ? path(device) : device.name)
      case 'KNAME': return device.name
      case 'PATH': return path(device)
      // util-linux pads the pair as %3u:%-3u in a table, and prints it plain in raw, pairs and JSON output
      case 'MAJ:MIN': return flags.has('r') || flags.has('P') || flags.has('J') ? `${device.maj}:${device.min}` : `${device.maj.padStart(3)}:${device.min.padEnd(3)}`
      case 'MAJ': return device.maj
      case 'MIN': return device.min
      case 'RM': return device.rm
      case 'SIZE': return flags.has('b') ? String(device.bytes) : human(device.bytes)
      case 'RO': return device.ro
      case 'TYPE': return device.type
      case 'MOUNTPOINT': return device.mountpoints[0] ?? ''
      case 'MOUNTPOINTS': return device.mountpoints.join('\n')
      case 'FSTYPE': return device.fstype
    }
    return ''
  }

  if (flags.has('J')) {
    const node = device => {
      const entry = {}
      for (const column of wanted) {
        const key = column.toLowerCase()
        if (column === 'MOUNTPOINTS') entry[key] = device.mountpoints.length ? device.mountpoints : [null]
        else if (column === 'RM') entry[key] = device.rm === '1'
        else if (column === 'RO') entry[key] = device.ro === '1'
        else entry[key] = value({ device, branch: '' }, column) || null
      }
      if (!flags.has('d') && !flags.has('l') && device.children.length) entry.children = device.children.map(node)
      return entry
    }
    const top = flags.has('l') ? rows.map(row => row.device) : rows.filter(row => !row.device.partition).map(row => row.device)
    out(JSON.stringify({ blockdevices: top.map(node) }, null, 3) + '\n')
    return 0
  }
  if (flags.has('P')) {
    for (const row of rows) out(wanted.map(column => `${column}="${value(row, column).replace(/\n/g, ',')}"`).join(' ') + '\n')
    return 0
  }

  // MOUNTPOINTS holds one per line: continuation lines are blank apart from that column
  const lines = rows.map(row => wanted.map(column => value(row, column)))
  const cells = flags.has('n') ? lines : [wanted, ...lines]
  if (flags.has('r')) {
    for (const row of cells) out(row.map(cell => cell.replace(/ /g, '\\x20').replace(/\n/g, ',')).join(' ') + '\n')
    return 0
  }
  const widths = wanted.map((_, column) => Math.max(...cells.map(row => Math.max(...row[column].split('\n').map(part => [...part].length)))))
  for (const row of cells) {
    const height = Math.max(...row.map(cell => cell.split('\n').length))
    for (let line = 0; line < height; line++) {
      const parts = row.map((cell, column) => {
        const part = cell.split('\n')[line] ?? ''
        return columns[wanted[column]].right ? part.padStart(widths[column]) : part.padEnd(widths[column])
      })
      if (line > 0) for (let column = 0; column < parts.length; column++) if (wanted[column] !== 'MOUNTPOINTS') parts[column] = ' '.repeat(widths[column])
      out(parts.join(' ').trimEnd() + '\n')
    }
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(`lsblk: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
