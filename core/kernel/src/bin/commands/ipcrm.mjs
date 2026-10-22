/**
 * Removes System V IPC objects, as util-linux's `ipcrm` does: by id (`-q`, `-m`, `-s`) or by key (`-Q`, `-M`, `-S`),
 * or every one of a kind the caller may remove (`-a [msg|shm|sem]`). A shared memory segment still attached goes when
 * its last attachment does. Each failure is reported and the rest are still tried.
 */

import { readText } from './lib/proc.mjs'

const { argv, exit, write, custom } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text))
const err = text => write(2, encoder.encode(`ipcrm: ${text}\n`))

const usage = `Usage:
 ipcrm [options]
 ipcrm shm|msg|sem <id>...

Remove certain IPC resources.

Options:
 -m, --shmem-id <id>        remove shared memory segment by id
 -M, --shmem-key <key>      remove shared memory segment by key
 -q, --queue-id <id>        remove message queue by id
 -Q, --queue-key <key>      remove message queue by key
 -s, --semaphore-id <id>    remove semaphore by id
 -S, --semaphore-key <key>  remove semaphore by key
 -a, --all[=shm|msg|sem]    remove all (in the specified category)
 -h, --help                 display this help
`

const IPC_RMID = 0
const OPTIONS = {
  m: ['shm', 'id'], M: ['shm', 'key'], q: ['msg', 'id'], Q: ['msg', 'key'], s: ['sem', 'id'], S: ['sem', 'key'],
  '--shmem-id': ['shm', 'id'], '--shmem-key': ['shm', 'key'], '--queue-id': ['msg', 'id'], '--queue-key': ['msg', 'key'],
  '--semaphore-id': ['sem', 'id'], '--semaphore-key': ['sem', 'key']
}
const KINDS = ['shm', 'msg', 'sem']

const codeOf = error => error?.code ?? /\b(E[A-Z]+)\b/.exec(error instanceof Error ? error.message : String(error))?.[1]

/** Removes one object; `how` and `text` name it in a message, as given */
async function remove(kind, how, text) {
  let id = Number(text)
  try {
    if (how === 'key') {
      if (!id) { err(`illegal key (${text})`); return false }
      id = await custom('ipc_get', kind, id | 0, 0, 0)
    }
    await custom('ipc_ctl', kind, id, IPC_RMID, null)
    return true
  } catch (error) {
    const code = codeOf(error)
    if (code === 'EACCES' || code === 'EPERM') err(`permission denied for ${how} (${text})`)
    else if (code === 'EINVAL' || code === 'ENOENT') err(`invalid ${how} (${text})`)
    else if (code === 'EIDRM') err(`already removed ${how} (${text})`)
    else err(`${how} (${text}): ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** Every object of `kind` in `/proc/sysvipc`, by id */
function idsOf(kind) {
  const [heading, ...lines] = readText(`/proc/sysvipc/${kind}`).split('\n').filter(Boolean)
  const at = heading.trim().split(/\s+/).indexOf(`${kind === 'msg' ? 'msq' : kind}id`)
  return lines.map(line => line.trim().split(/\s+/)[at])
}

const number = text => /^(0x[0-9a-f]+|\d+)$/i.test(text ?? '')

async function main() {
  const args = argv.slice(1)
  if (!args.length) { out(usage); return 1 }
  let ok = true
  // the old form: a kind, then its ids
  if (KINDS.includes(args[0])) {
    if (args.length < 2) { err('not enough arguments'); return 1 }
    for (const text of args.slice(1)) ok = await remove(args[0], 'id', text) && ok
    return ok ? 0 : 1
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-h' || arg === '--help') { out(usage); return 0 }
    if (arg === '-a' || arg === '--all' || arg.startsWith('--all=')) {
      const named = arg.startsWith('--all=') ? arg.slice(6) : KINDS.includes(args[i + 1]) ? args[++i] : undefined
      if (named !== undefined && !KINDS.includes(named)) { err(`unknown argument: ${named}`); return 1 }
      for (const kind of named ? [named] : KINDS) {
        for (const id of idsOf(kind)) ok = await remove(kind, 'id', id) && ok
      }
      continue
    }
    const option = arg.startsWith('--') ? arg.split('=')[0] : arg.startsWith('-') ? arg[1] : undefined
    const spec = option && OPTIONS[option]
    if (!spec) { err(`invalid option -- '${arg.replace(/^--?/, '')}'`); write(2, encoder.encode("Try 'ipcrm --help' for more information.\n")); return 1 }
    const text = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg.length > 2 && !arg.startsWith('--') ? arg.slice(2) : args[++i]
    if (!number(text)) { err(`${text === undefined ? 'option requires an argument' : `failed to parse argument: '${text}'`}`); return 1 }
    ok = await remove(spec[0], spec[1], text) && ok
  }
  return ok ? 0 : 1
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
