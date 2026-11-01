/** `blkid`: print the attributes of block devices, read from `/sys/block` and `/proc/mounts`. A machine with no block devices prints nothing and exits 2, as blkid does. */

import { getopt } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll, readdir } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`blkid: ${text}\n`))

const usage = `Usage:
 blkid [options] [<device> ...]

Locate and print block device attributes.

Options:
 -o, --output <format>   output format: full, value, list, device, export
 -s, --match-tag <tag>   show the specified tag only (TYPE or PARTUUID)
 -h, --help              display this help`

const names = path => {
  try { return readdir(path).map(entry => (typeof entry === 'string' ? entry : entry.name)).filter(name => name !== '.' && name !== '..').sort() } catch { return [] }
}
const text = path => { try { return readTextFile(path).trim() } catch { return '' } }

/** Every disk and partition in /sys/block with the filesystem type /proc/mounts gives it */
function devices() {
  const types = new Map()
  for (const line of text('/proc/mounts').split('\n')) {
    const [source, , type] = line.split(' ')
    if (source?.startsWith('/dev/')) types.set(source.slice(5), type)
  }
  const found = []
  for (const disk of names('/sys/block')) {
    found.push({ name: disk, type: types.get(disk) })
    for (const part of names(`/sys/block/${disk}`)) {
      if (text(`/sys/block/${disk}/${part}/partition`)) found.push({ name: part, type: types.get(part) })
    }
  }
  return found.filter(device => device.type !== undefined)
}

function main() {
  const parsed = getopt(argv.slice(1), {
    short: 'o:s:h',
    long: { output: { key: 'o', arg: 'required' }, 'match-tag': { key: 's', arg: 'required' }, help: 'h' }
  })
  if (parsed.error) { err(parsed.error); return 4 }
  const flags = new Map(parsed.options)
  if (flags.has('h')) { out(usage + '\n'); return 0 }
  const format = typeof flags.get('o') === 'string' ? flags.get('o') : 'full'
  if (!['full', 'value', 'list', 'device', 'export'].includes(format)) { err(`unsupported output format ${format}`); return 4 }
  const tag = typeof flags.get('s') === 'string' ? flags.get('s').toUpperCase() : undefined

  let found = devices()
  if (parsed.operands.length) {
    const wanted = parsed.operands.map(path => path.replace(/^\/dev\//, ''))
    found = found.filter(device => wanted.includes(device.name))
  }
  if (!found.length) return 2

  for (const device of found) {
    const path = `/dev/${device.name}`
    const tags = tag === undefined || tag === 'TYPE' ? [['TYPE', device.type]] : []
    if (!tags.length) continue
    if (format === 'device') out(`${path}\n`)
    else if (format === 'value') out(tags.map(([, value]) => value).join('\n') + '\n')
    else if (format === 'export') out(`DEVNAME=${path}\n${tags.map(([key, value]) => `${key}=${value}`).join('\n')}\n\n`)
    else if (format === 'list') out(`${path} ${device.type}\n`)
    else out(`${path}: ${tags.map(([key, value]) => `${key}="${value}"`).join(' ')}\n`)
  }
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
