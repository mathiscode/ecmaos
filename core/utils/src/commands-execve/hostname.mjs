/**
 * Show or set the system's host name: the kernel's, `/proc/sys/kernel/hostname`, which boot takes from `/etc/hostname`.
 * Setting it (root only) lasts until the next boot, as on Linux; `hostnamectl set-hostname` also writes the file.
 */

import { readTextFile } from './lib/fs-text.mjs'
import { reasonOf } from './lib/errno.mjs'

const { argv, exit, writeAll, env, open, close, geteuid, O_WRONLY, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: hostname [OPTION] [NAME]
Show or set the system's host name.

  -f, --fqdn              print the FQDN (Fully Qualified Domain Name)
  -s, --short             print the short hostname
  -F, --file FILE         set the host name from FILE
  --help                  display this help and exit`

const KERNEL_HOSTNAME = '/proc/sys/kernel/hostname'

function current() {
  try { return readTextFile(KERNEL_HOSTNAME).trim() || env.HOSTNAME || 'localhost' } catch { return env.HOSTNAME || 'localhost' }
}

function setName(name) {
  if (geteuid() !== 0) { writeAll(2, new TextEncoder().encode('hostname: you must be root to change the host name\n')); return 1 }
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/.test(name) || name.length > 64) {
    writeAll(2, new TextEncoder().encode('hostname: the specified hostname is invalid\n'))
    return 1
  }
  try {
    const fd = open(KERNEL_HOSTNAME, O_WRONLY | O_TRUNC)
    try { writeAll(fd, new TextEncoder().encode(name + '\n')) } finally { close(fd) }
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`hostname: ${reasonOf(error)}\n`))
    return 1
  }
  return 0
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(1, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let showFqdn = false
  let showShort = false
  const positional = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '-F' || arg === '--file') {
      const file = args[++i]
      if (file === undefined) { writeAll(2, new TextEncoder().encode("hostname: option requires an argument -- 'F'\n")); return 1 }
      let text
      try { text = readTextFile(file) } catch (error) { writeAll(2, new TextEncoder().encode(`hostname: ${file}: ${reasonOf(error)}\n`)); return 1 }
      const name = text.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#'))
      return name ? setName(name) : 0
    } else if (arg === '--help' || arg === '-h') {
      writeAll(1, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-f' || arg === '--fqdn') {
      showFqdn = true
    } else if (arg === '-s' || arg === '--short') {
      showShort = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('f')) showFqdn = true
      if (flags.includes('s')) showShort = true
      const invalid = flags.find(f => !['f', 's'].includes(f))
      if (invalid) {
        writeAll(2, new TextEncoder().encode(`hostname: invalid option -- '${invalid}'\nTry 'hostname --help' for more information.\n`))
        return 1
      }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) {
    writeAll(2, new TextEncoder().encode("hostname: too many arguments\nTry 'hostname --help' for more information.\n"))
    return 1
  }
  if (positional.length === 1) return setName(positional[0])

  const hostname = current()
  let output

  if (showFqdn) {
    output = hostname
  } else if (showShort) {
    output = hostname.split('.')[0] ?? hostname
  } else {
    output = hostname
  }

  writeAll(1, new TextEncoder().encode(output + '\n'))
  return 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`hostname: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
