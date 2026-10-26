/** `renice`: change the niceness of running processes, by pid, process group or user. See `nice` for what niceness means here. */

import { getopt } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll, custom, readdir } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`renice: ${text}\n`))

const usage = `Usage:
 renice [-n] <priority> [-p|--pid] <pid>...
 renice [-n] <priority>  -g|--pgrp <pgid>...
 renice [-n] <priority>  -u|--user <user>...

Alter the priority of running processes.

 -g, --pgrp <id>        interpret argument as process group ID
 -n, --priority <num>   specify the nice increment value
 -p, --pid <id>         interpret argument as process ID (default)
 -u, --user <name|id>   interpret argument as username or user ID
     --help             display this help
 -V, --version          display version

The value is the new niceness (-20 to 19). Lowering it, or changing another user's process, is for root.`

const numbers = () => readdir('/proc').map(entry => (typeof entry === 'string' ? entry : entry.name)).filter(name => /^\d+$/.test(name)).map(Number)
const fieldsOf = pid => {
  const stat = readTextFile(`/proc/${pid}/stat`)
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
}
function usersId(name) {
  if (/^\d+$/.test(name)) return Number(name)
  for (const line of readTextFile('/etc/passwd').split('\n')) {
    const parts = line.split(':')
    if (parts[0] === name) return Number(parts[2])
  }
  return undefined
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'gn:pu:V', long: { pgrp: 'g', priority: { key: 'n', arg: 'required' }, pid: 'p', user: 'u', version: 'V', help: 'help' }, permute: true })
  if (error) { err(error); return 1 }
  let priority
  let mode = 'p'
  const ids = [...operands]
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'V') { out('renice (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'n') priority = value
    else if (key === 'g' || key === 'p' || key === 'u') mode = key
  }
  // the old form: renice PRIORITY ID...
  if (priority === undefined) priority = ids.shift()
  if (priority === undefined || !/^[+-]?\d+$/.test(priority)) { err(priority === undefined ? 'not enough arguments' : `invalid priority ‘${priority}’`); return 1 }
  if (!ids.length) { err('not enough arguments'); return 1 }

  let status = 0
  const change = async (pid, label) => {
    try {
      const before = (await custom('proc_nice', 0, pid, 0)) - 20
      const after = (await custom('proc_nice', 1, pid, Number(priority))) - 20
      out(`${label} old priority ${before}, new priority ${after}\n`)
    } catch (e) {
      err(`failed to set priority for ${pid} (${label.split(' ')[1].replace(/[()]/g, '')}): ${e?.message ?? e}`)
      status = 1
    }
  }
  for (const id of ids) {
    if (mode === 'p') {
      if (!/^\d+$/.test(id)) { err(`bad value ${id}`); status = 1; continue }
      await change(Number(id), `${id} (process ID)`)
    } else if (mode === 'g') {
      if (!/^\d+$/.test(id)) { err(`bad value ${id}`); status = 1; continue }
      const members = numbers().filter(pid => { try { return Number(fieldsOf(pid)[2]) === Number(id) } catch { return false } })
      if (!members.length) { err(`failed to get priority for ${id} (process group ID): No such process`); status = 1; continue }
      for (const pid of members) await change(pid, `${pid} (process ID)`)
    } else {
      const uid = usersId(id)
      if (uid === undefined) { err(`failed to get uid for ${id}`); status = 1; continue }
      for (const pid of numbers()) {
        let owner
        try { owner = Number(/^Uid:\s+(\d+)/m.exec(readTextFile(`/proc/${pid}/status`))?.[1]) } catch { continue }
        if (owner === uid) await change(pid, `${pid} (process ID)`)
      }
    }
  }
  return status
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
