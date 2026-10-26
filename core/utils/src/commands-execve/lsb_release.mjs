/** Print distribution information, read from `/etc/os-release`, with `lsb_release`'s options and wording. */

import { getopt } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`lsb_release: ${text}\n`))

const usage = `Usage: lsb_release [options]

Options:
  -h, --help         show this help message and exit
  -v, --version      show LSB modules this system supports
  -i, --id           show distributor ID
  -d, --description  show description of this distribution
  -r, --release      show release number of this distribution
  -c, --codename     show code name of this distribution
  -a, --all          show all of the above information
  -s, --short        show requested information in a short format`

function osRelease() {
  const values = {}
  let text = ''
  try { text = readTextFile('/etc/os-release') } catch { /* an absent file leaves n/a */ }
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return values
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'hvidrcas', long: { help: 'h', version: 'v', id: 'i', description: 'd', release: 'r', codename: 'c', all: 'a', short: 's' } })
  if (error) { err(error); return 2 }
  if (operands.length) { err(`unrecognized arguments: ${operands.join(' ')}`); return 2 }
  const keys = options.map(([key]) => key)
  if (keys.includes('h')) { out(usage + '\n'); return 0 }
  const os = osRelease()
  const info = [
    ['i', 'Distributor ID', os.NAME ?? os.ID ?? 'n/a'],
    ['d', 'Description', os.PRETTY_NAME ?? os.NAME ?? 'n/a'],
    ['r', 'Release', os.VERSION_ID ?? 'rolling'],
    ['c', 'Codename', os.VERSION_CODENAME ?? 'n/a']
  ]
  const short = keys.includes('s')
  if (keys.includes('v')) { out(short ? 'n/a\n' : 'LSB Version:\tn/a\n'); if (!keys.includes('a') && !keys.some(key => 'idrc'.includes(key))) return 0 }
  const all = keys.includes('a') || !keys.some(key => 'idrc'.includes(key))
  const wanted = info.filter(([key]) => all || keys.includes(key))
  if (keys.includes('a') && !short) out('LSB Version:\tn/a\n')
  for (const [, label, value] of wanted) out(short ? `${value}\n` : `${label}:\t${value}\n`)
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
