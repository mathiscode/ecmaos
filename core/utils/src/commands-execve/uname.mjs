/**
 * Print system information, as GNU `uname` does: the kernel name (`Linux`, which is what scripts test), the host name,
 * the kernel release (the ecmaOS version), a version string, the machine (`x86_64`, `aarch64`...), and the
 * operating system (`GNU/Linux`). `-a` leaves out a processor or platform that is `unknown`, as GNU does.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { machineName } from './lib/machine.mjs'

const { argv, exit, writeAll, env } = globalThis.ecmaosSyscalls

/** The kernel's host name, as `/proc/sys/kernel/hostname` has it */
function nodename() {
  try { return readTextFile('/proc/sys/kernel/hostname').trim() || env.HOSTNAME || 'localhost' } catch { return env.HOSTNAME || 'localhost' }
}

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`uname: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('uname') + '\n'))

const usage = `Usage: uname [OPTION]...
Print certain system information.  With no OPTION, same as -s.

  -a, --all                print all information, in the following order,
                             except omit -p and -i if unknown:
  -s, --kernel-name        print the kernel name
  -n, --nodename           print the network node hostname
  -r, --kernel-release     print the kernel release
  -v, --kernel-version     print the kernel version
  -m, --machine            print the machine hardware name
  -p, --processor          print the processor type (non-portable)
  -i, --hardware-platform  print the hardware platform (non-portable)
  -o, --operating-system   print the operating system
      --help        display this help and exit
      --version     output version information and exit
`

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'asnrvmpio',
    long: {
      all: 'a', 'kernel-name': 's', nodename: 'n', 'kernel-release': 'r', 'kernel-version': 'v', machine: 'm',
      processor: 'p', 'hardware-platform': 'i', 'operating-system': 'o', help: 'help', version: 'version'
    }
  })
  if (error) { err(error); hint(); return 1 }
  const keys = new Set(options.map(([key]) => key))
  if (keys.has('help')) { out(usage); return 0 }
  if (keys.has('version')) { out('uname (ecmaOS coreutils) 1.0\n'); return 0 }
  if (operands.length) { err(`extra operand ‘${operands[0]}’`); hint(); return 1 }

  const all = keys.has('a')
  const fields = {
    s: 'Linux',
    n: nodename(),
    r: env.KERNEL_VERSION || '0.0.0',
    v: `#1 ${env.KERNEL_NAME || 'ecmaOS'} ${env.KERNEL_VERSION || ''}`.trim(),
    m: await machineName(),
    p: 'unknown',
    i: 'unknown',
    o: 'GNU/Linux'
  }
  const chosen = all ? ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'] : ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'].filter(key => keys.has(key))
  if (chosen.length === 0) chosen.push('s')
  const parts = chosen.filter(key => !(all && (key === 'p' || key === 'i') && fields[key] === 'unknown')).map(key => fields[key])
  out(parts.join(' ') + '\n')
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
