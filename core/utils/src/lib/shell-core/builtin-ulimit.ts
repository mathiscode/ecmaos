/**
 * `ulimit`, as far as it can be true. Nothing in a browser enforces a per-process resource limit, and the
 * upstream `getrlimit`/`setrlimit` are stubs that return 0 and keep nothing. So this reports what holds and
 * does not pretend to change what cannot:
 *
 * - `-f` is the one real limit: the most a file on the machine's storage may hold (`EFBIG` beyond it), which
 *   depends on the device's memory and is the same for every process.
 * - `-c` is 0: no core file is ever written.
 * - the rest are unlimited, because nothing limits them; `-p` and the priorities are fixed.
 *
 * Setting a limit to the value it already has succeeds (`ulimit -c 0`, `ulimit -n unlimited`). Raising one
 * fails as it does for an unprivileged user, and lowering one fails because nothing would enforce it.
 */

import type { BuiltinHost, BuiltinIO } from './builtins.js'

/** What the limits are read from, fetched once per call because the host may have to ask the kernel. */
interface Context { fileBytes: number | undefined }

interface Resource {
  flag: string
  label: string
  /** The unit shown in `-a`, e.g. `blocks`; empty for none. */
  unit: string
  /** What one unit is, in the value `ulimit` prints; 1 for a plain count. */
  value: (context: Context) => number | undefined
  /** Whether a different value can ever be set; the fixed ones refuse anything else. */
  fixed?: boolean
}

const UNLIMITED = (): undefined => undefined

/** In bash's `-a` order. A value of `undefined` is "unlimited". */
const RESOURCES: readonly Resource[] = [
  { flag: 'R', label: 'real-time non-blocking time', unit: 'microseconds', value: UNLIMITED },
  { flag: 'c', label: 'core file size', unit: 'blocks', value: () => 0 },
  { flag: 'd', label: 'data seg size', unit: 'kbytes', value: UNLIMITED },
  { flag: 'e', label: 'scheduling priority', unit: '', value: () => 0, fixed: true },
  { flag: 'f', label: 'file size', unit: 'blocks', value: ({ fileBytes }) => fileBytes === undefined ? undefined : Math.floor(fileBytes / 1024) },
  { flag: 'i', label: 'pending signals', unit: '', value: UNLIMITED },
  { flag: 'l', label: 'max locked memory', unit: 'kbytes', value: UNLIMITED },
  { flag: 'm', label: 'max memory size', unit: 'kbytes', value: UNLIMITED },
  { flag: 'n', label: 'open files', unit: '', value: UNLIMITED },
  { flag: 'p', label: 'pipe size', unit: '512 bytes', value: () => 8, fixed: true },
  { flag: 'q', label: 'POSIX message queues', unit: 'bytes', value: UNLIMITED },
  { flag: 'r', label: 'real-time priority', unit: '', value: () => 0, fixed: true },
  { flag: 's', label: 'stack size', unit: 'kbytes', value: UNLIMITED },
  { flag: 't', label: 'cpu time', unit: 'seconds', value: UNLIMITED },
  { flag: 'u', label: 'max user processes', unit: '', value: UNLIMITED },
  { flag: 'v', label: 'virtual memory', unit: 'kbytes', value: UNLIMITED },
  { flag: 'x', label: 'file locks', unit: '', value: UNLIMITED },
]

const USAGE = 'ulimit: usage: ulimit [-SHabcdefiklmnpqrstuvxPRT] [limit]'
const show = (value: number | undefined): string => value === undefined ? 'unlimited' : String(value)

function line(resource: Resource, value: number | undefined): string {
  const unit = resource.unit ? `(${resource.unit}, -${resource.flag})` : `(-${resource.flag})`
  const gap = Math.max(2, 40 - resource.label.length - unit.length)
  return `${resource.label}${' '.repeat(gap)}${unit} ${show(value)}`
}

export async function ulimitBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  const context: Context = { fileBytes: await host.fileSizeLimit?.() }
  const wanted: Resource[] = []
  let all = false
  let operand: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help') {
      await io.writeln('Usage: ulimit [-SHa] [-cdefilmnpqrstuvxR] [LIMIT]\nShow or set resource limits.\n\n  -a  list every limit      -S, -H  the soft or the hard limit (the same here)\n  -f  the largest file (default)   -c  core file size   -n  open files\n\nOnly some limits are real here. `-f` is the machine\'s file size cap, `-c` is 0 because no core\nfile is ever written, and the rest are unlimited because nothing limits them. A limit can be set\nto the value it already has; raising one is refused, and so is lowering one, since nothing would\nenforce it.')
      return 0
    }
    if (arg === '--') { operand = argv[i + 1]; break }
    if (arg.length > 1 && arg.startsWith('-') && !/^-\d/.test(arg)) {
      for (const letter of arg.slice(1)) {
        if (letter === 'S' || letter === 'H') continue
        if (letter === 'a') { all = true; continue }
        const resource = RESOURCES.find(r => r.flag === letter)
        if (!resource) { await io.writelnErr(`ulimit: -${letter}: invalid option\n${USAGE}`); return 2 }
        wanted.push(resource)
      }
      continue
    }
    if (operand !== undefined) { await io.writelnErr('ulimit: too many arguments'); return 2 }
    operand = arg
  }

  if (all) {
    await io.write(RESOURCES.map(r => `${line(r, r.value(context))}\n`).join(''))
    return 0
  }

  const resources = wanted.length > 0 ? wanted : [RESOURCES.find(r => r.flag === 'f') as Resource]
  if (operand === undefined) {
    for (const resource of resources) {
      const value = resource.value(context)
      await io.writeln(resources.length > 1 ? line(resource, value) : show(value))
    }
    return 0
  }

  let status = 0
  const requested = ['unlimited', 'hard', 'soft'].includes(operand) ? undefined : Number(operand)
  if (requested !== undefined && (!/^\d+$/.test(operand))) { await io.writelnErr(`ulimit: ${operand}: invalid number`); return 1 }
  for (const resource of resources) {
    const current = resource.value(context)
    if (requested === current || (operand === 'hard' || operand === 'soft')) continue
    const raising = current !== undefined && (requested === undefined || requested > current)
    if (raising || resource.fixed) await io.writelnErr(`ulimit: ${resource.label}: cannot modify limit: Operation not permitted`)
    else await io.writelnErr(`ulimit: ${resource.label}: cannot lower the limit: nothing here enforces it`)
    status = 1
  }
  return status
}
