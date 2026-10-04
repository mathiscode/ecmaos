/**
 * Estimate how much space files take: `du -sh dir`, `du -d 1 .`.
 *
 * There are no disk blocks here, so sizes are the sizes of the files themselves, rounded up to 1 KiB (`-b`
 * gives bytes). A directory counts only what is in it. Symbolic links are not followed.
 */

import { join, resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, lstat, readdir } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`du: ${text}\n`))
const S_IFMT = 0xf000
const S_IFDIR = 0x4000

const usage = `Usage: du [OPTION]... [FILE]...
Summarize the size of each FILE, and of every directory in it, recursively (the current directory by default).

  -a, --all             show a size for files too, not only directories
  -b, --bytes           sizes in bytes
  -k                    sizes in KiB (the default)
  -h, --human-readable  sizes as 1K, 234M, 2G
  -s, --summarize       show only a total for each argument
  -c, --total           also show a grand total
  -d, --max-depth=N     show sizes only for directories N levels down or fewer
  --help                display this help and exit`

function human(bytes) {
  const units = ['', 'K', 'M', 'G', 'T']
  let value = bytes
  let unit = 0
  while (value > 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  if (unit === 0) return String(bytes)
  const rounded = Math.ceil(value * 10) / 10
  return (rounded >= 10 ? String(Math.ceil(value)) : rounded.toFixed(1).replace(/\.0$/, '')) + units[unit]
}

function main() {
  const args = argv.slice(1)
  const o = { all: false, bytes: false, human: false, summarize: false, total: false, depth: Infinity }
  const paths = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (arg === '--') { paths.push(...args.slice(i + 1)); break }
    if (!arg.startsWith('-') || arg === '-') { paths.push(arg); continue }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=')
      if (name === 'all') o.all = true
      else if (name === 'bytes') o.bytes = true
      else if (name === 'human-readable') o.human = true
      else if (name === 'summarize') o.summarize = true
      else if (name === 'total') o.total = true
      else if (name === 'max-depth') { o.depth = Number(inline ?? args[++i]) }
      else { err(`unrecognized option '${arg}'`); return 1 }
      continue
    }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]
      if (letter === 'a') o.all = true
      else if (letter === 'b') o.bytes = true
      else if (letter === 'k') o.human = false
      else if (letter === 'h') o.human = true
      else if (letter === 's') o.summarize = true
      else if (letter === 'c') o.total = true
      else if (letter === 'd') { o.depth = Number(arg.slice(j + 1) || args[++i]); break }
      else { err(`invalid option -- '${letter}'`); return 1 }
    }
  }
  if (!Number.isFinite(o.depth) && o.depth !== Infinity || o.depth < 0) { err('invalid maximum depth'); return 1 }
  if (o.summarize) o.depth = 0
  if (paths.length === 0) paths.push('.')

  const cwd = getcwd()
  const show = size => o.bytes ? String(size) : o.human ? human(size) : String(Math.ceil(size / 1024))
  let failed = false
  let grand = 0
  const lines = []

  /** The size of `path` and everything below it; prints a line for it when depth allows. */
  function walk(shown, full, depth) {
    let info
    try { info = lstat(full) } catch (error) { err(`cannot access '${shown}': ${error?.message ?? error}`); failed = true; return 0 }
    let size = Number(info.size ?? 0)
    if ((info.mode & S_IFMT) === S_IFDIR) {
      size = 0
      let names = []
      try { names = readdir(full).filter(name => name !== '.' && name !== '..').sort() } catch (error) { err(`cannot read directory '${shown}': ${error?.message ?? error}`); failed = true }
      for (const name of names) size += walk(shown.endsWith('/') ? shown + name : `${shown}/${name}`, join(full, name), depth + 1)
      if (depth <= o.depth) lines.push(`${show(size)}\t${shown}`)
    } else if (depth <= o.depth && (o.all || depth === 0)) lines.push(`${show(size)}\t${shown}`)
    return size
  }

  for (const path of paths) grand += walk(path, resolve(cwd, path), 0)
  if (o.total) lines.push(`${show(grand)}\ttotal`)
  if (lines.length) writeAll(1, encoder.encode(lines.join('\n') + '\n'))
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
