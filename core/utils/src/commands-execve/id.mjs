/**
 * Print user and group information, as GNU `id` does: `uid=1000(name) gid=1000(name) groups=1000(name),10(wheel)` for
 * the caller or each USER named, or with `-u`, `-g` or `-G` one kind of id alone (`-n` as names, `-r` as the real
 * ids, `-z` ending with NUL). `euid=` and `egid=` appear when they differ from the real ids.
 */

import { readFileBytes } from './lib/bytes.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, exit, writeAll, custom, unlink } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`id: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('id') + '\n'))
const quote = text => `‘${text}’`

const usage = `Usage: id [OPTION]... [USER]...
Print user and group information for each specified USER,
or (when USER omitted) for the current process.

  -a             ignore, for compatibility with other versions
  -Z, --context  print only the security context of the process
  -g, --group    print only the effective group ID
  -G, --groups   print all group IDs
  -n, --name     print a name instead of a number, for -ugG
  -r, --real     print the real ID instead of the effective ID, with -ugG
  -u, --user     print only the effective user ID
  -z, --zero     delimit entries with NUL characters, not whitespace;
                   not permitted in default format
      --help        display this help and exit
      --version     output version information and exit

Without any OPTION, print some useful set of identified information.
`

async function lookup(query) {
  const path = `/tmp/.users_lookup-${Math.random().toString(36).slice(2)}`
  await custom('users_lookup', JSON.stringify(query), path)
  try {
    return JSON.parse(new TextDecoder().decode(readFileBytes(path)))
  } finally {
    try { unlink(path) } catch { /* best-effort cleanup */ }
  }
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'agGnruzZ',
    long: { context: 'Z', group: 'g', groups: 'G', name: 'n', real: 'r', user: 'u', zero: 'z', help: 'help', version: 'version' }
  })
  if (error) { err(error); hint(); return 1 }
  const flags = new Set(options.map(([key]) => key))
  if (flags.has('help')) { out(usage); return 0 }
  if (flags.has('version')) { out('id (ecmaOS coreutils) 1.0\n'); return 0 }
  if (flags.has('Z')) { err('--context (-Z) works only on an SELinux-enabled kernel'); return 1 }

  const chosen = ['u', 'g', 'G'].filter(key => flags.has(key))
  if (chosen.length > 1) { err('cannot print "only" of more than one choice'); return 1 }
  if (chosen.length === 0 && (flags.has('n') || flags.has('r'))) { err('printing only names or real IDs requires -u, -g, or -G'); return 1 }
  if (chosen.length === 0 && flags.has('z')) { err('option --zero not permitted in default format'); return 1 }
  const only = chosen[0]
  const names = flags.has('n')
  const real = flags.has('r')
  const end = flags.has('z') ? '\0' : '\n'

  const groupNames = new Map()
  const groupName = async gid => {
    if (!groupNames.has(gid)) groupNames.set(gid, (await lookup({ mode: 'group', gid }))?.name)
    return groupNames.get(gid)
  }
  const userName = async record => record.username

  let failed = false
  const subjects = operands.length ? operands : [undefined]
  for (const operand of subjects) {
    let record
    if (operand === undefined) record = await lookup({ mode: 'self' })
    else {
      record = await lookup({ mode: 'byUsername', username: operand })
      if (!record && /^\d+$/.test(operand)) record = await lookup({ mode: 'byUid', uid: Number(operand) })
    }
    if (!record) { err(`${quote(operand)}: no such user`); failed = true; continue }

    const uid = record.uid
    const gid = record.gid
    const euid = operand === undefined ? record.euid ?? uid : uid
    const egid = operand === undefined ? record.egid ?? gid : gid
    const supplementary = (record.groups || [])
    // the effective group first, then the real one, then the rest
    const groups = [...new Set([egid, gid, ...supplementary])]
    const name = await userName(record)
    const label = async (id, kind) => {
      if (kind === 'user') return id === record.uid ? name : (await lookup({ mode: 'byUid', uid: id }))?.username
      return await groupName(id)
    }

    if (only === 'u') {
      const id = real ? uid : euid
      out(`${names ? (await label(id, 'user')) ?? id : id}${end}`)
    } else if (only === 'g') {
      const id = real ? gid : egid
      out(`${names ? (await groupName(id)) ?? id : id}${end}`)
    } else if (only === 'G') {
      const parts = []
      for (const id of groups) parts.push(names ? (await groupName(id)) ?? String(id) : String(id))
      out(parts.join(flags.has('z') ? '\0' : ' ') + end)
    } else {
      const paren = async (id, kind) => {
        const text = kind === 'user' ? await label(id, 'user') : await groupName(id)
        return text === undefined ? String(id) : `${id}(${text})`
      }
      let line = `uid=${await paren(uid, 'user')} gid=${await paren(gid, 'group')}`
      if (euid !== uid) line += ` euid=${await paren(euid, 'user')}`
      if (egid !== gid) line += ` egid=${await paren(egid, 'group')}`
      const parts = []
      for (const id of groups) parts.push(await paren(id, 'group'))
      out(`${line} groups=${parts.join(',')}\n`)
    }
  }
  return failed ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
