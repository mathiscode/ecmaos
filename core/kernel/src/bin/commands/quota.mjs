/**
 * Show storage quotas and what is used against them: `quota`, `quota alice`, `quota -r` (root: read /etc/quota again).
 * A user sees their own; root sees everyone who has a quota. Limits come from /etc/quota (see `man quota`).
 */
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'
import { getopt } from './lib/getopt.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, custom } = syscalls
const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text + '\n'))
const err = text => write(2, encoder.encode(`quota: ${text}\n`))

const usage = `Usage: quota [-r] [-b] [USER]
Show the storage quota of USER (yourself by default; root may name anyone, or leave it out to list every quota) and how much of it the
user's files on the root filesystem use. Quotas are set in /etc/quota.

  -b, --bytes   sizes in bytes
  -r, --reload  read /etc/quota again (root)
  --help        display this help and exit`

const human = bytes => {
  const units = ['B', 'K', 'M', 'G', 'T']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return unit === 0 ? String(bytes) : `${value >= 10 ? Math.round(value) : value.toFixed(1)}${units[unit]}`
}

async function main() {
  const parsed = getopt(argv.slice(1), { flags: 'br', long: { bytes: 'b', reload: 'r' } })
  if (parsed.error) { err(parsed.error); return 1 }
  const { opts, rest } = parsed
  if (opts.help) { write(2, encoder.encode(usage + '\n')); return 0 }
  if (rest.length > 1) { err('one user at a time'); return 1 }
  const path = scratchPath('quota')
  await custom('quota_report', JSON.stringify({ user: rest[0], reload: !!opts.r }), path)
  const result = JSON.parse(await readBackAndDelete(syscalls, path))
  if (result.error) { err(result.error); return 1 }
  for (const problem of result.problems ?? []) err(problem)
  if (opts.r) out(`quota: ${result.rows.length} quota${result.rows.length === 1 ? '' : 's'} loaded`)
  if (result.rows.length === 0) { if (!opts.r) out(rest[0] || !result.listing ? 'No quota set.' : 'No quotas set.'); return 0 }
  const size = bytes => opts.b ? String(bytes) : human(bytes)
  const width = Math.max(4, ...result.rows.map(row => row.user.length))
  out(`${'User'.padEnd(width)}  ${'Used'.padStart(7)}  ${'Limit'.padStart(7)}  Use%`)
  for (const row of result.rows) out(`${row.user.padEnd(width)}  ${size(row.used).padStart(7)}  ${size(row.limit).padStart(7)}  ${String(Math.round(row.used * 100 / row.limit)).padStart(3)}%`)
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
