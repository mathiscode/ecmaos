/**
 * Estimate file space usage, as GNU `du` does. A file takes whole 4 KiB blocks (a symlink and a directory take
 * none here), `--apparent-size` and `-b` use the byte counts instead, and a file with several links is counted once
 * unless `-l`. Sizes print in 1 KiB units (`-k`, the default), `-m`, `-B SIZE`, `-h` (powers of 1024, rounded up
 * with one decimal below ten) or `--si` (powers of 1000). `-s`, `-d N`, `-a`, `-c`, `-S`, `-x`, `-L`, `-D`, `-P`,
 * `-t`, `--time`, `--exclude`, `--files0-from` and `-0` work as in GNU.
 */

import { join, resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { compile as compileGlob } from './lib/fnmatch.mjs'
import { readFileBytes, joinChunks } from './lib/bytes.mjs'
import { strftime } from './lib/strftime.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, lstat, stat, readdir, env } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`du: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('du') + '\n'))

const S_IFMT = 0xf000
const S_IFDIR = 0x4000
const S_IFREG = 0x8000
const BLOCK = 4096

const usage = `Usage: du [OPTION]... [FILE]...
  or:  du [OPTION]... --files0-from=F
Summarize device usage of the set of FILEs, recursively for directories.

Mandatory arguments to long options are mandatory for short options too.
  -0, --null            end each output line with NUL, not newline
  -a, --all             write counts for all files, not just directories
      --apparent-size   print apparent sizes rather than device usage; although
                          the apparent size is usually smaller, it may be
                          larger due to holes in ('sparse') files, internal
                          fragmentation, indirect blocks, and the like
  -B, --block-size=SIZE  scale sizes by SIZE before printing them; e.g.,
                           '-BM' prints sizes in units of 1,048,576 bytes;
                           see SIZE format below
  -b, --bytes           equivalent to '--apparent-size --block-size=1'
  -c, --total           produce a grand total
  -D, --dereference-args  dereference only symlinks that are listed on the
                          command line
  -d, --max-depth=N     print the total for a directory (or file, with --all)
                          only if it is N or fewer levels below the command
                          line argument;  --max-depth=0 is the same as
                          --summarize
      --files0-from=F   summarize device usage of the
                          NUL-terminated file names specified in file F;
                          if F is -, then read names from standard input
  -H                    equivalent to --dereference-args (-D)
  -h, --human-readable  print sizes in human readable format (e.g., 1K 234M 2G)
      --inodes          list inode usage information instead of block usage
  -k                    like --block-size=1K
  -L, --dereference     dereference all symbolic links
  -l, --count-links     count sizes many times if hard linked
  -m                    like --block-size=1M
  -P, --no-dereference  don't follow any symbolic links (this is the default)
  -S, --separate-dirs   for directories do not include size of subdirectories
      --si              like -h, but use powers of 1000 not 1024
  -s, --summarize       display only a total for each argument
  -t, --threshold=SIZE  exclude entries smaller than SIZE if positive,
                          or entries greater than SIZE if negative
      --time            show time of the last modification of any file in the
                          directory, or any of its subdirectories
      --time=WORD       show time as WORD instead of modification time:
                          atime, access, use, ctime or status
      --time-style=STYLE  show times using STYLE, which can be:
                            full-iso, long-iso, iso, or +FORMAT;
                            FORMAT is interpreted like in 'date'
  -X, --exclude-from=FILE  exclude files that match any pattern in FILE
      --exclude=PATTERN    exclude files that match PATTERN
  -x, --one-file-system    skip directories on different file systems
      --help        display this help and exit
      --version     output version information and exit
`

const UNITS = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 }

/** A SIZE as `-B` and `-t` take it: digits then an optional K, M, G (powers of 1024) or KB, MB, GB (1000); `undefined` when bad */
function parseSize(text) {
  const match = /^(-?\d*\.?\d*)([KMGTPE]?)(B|iB)?$/i.exec(text)
  if (!match || match[1] === '' || match[1] === '-') return undefined
  const [, digits, unit, tail] = match
  const power = unit ? UNITS[unit.toUpperCase()] : 0
  const base = tail === 'B' ? 1000 : 1024
  return Math.round(Number(digits) * base ** power)
}

/** `1.1K`, `12K`, `4.0M`: rounded up, one decimal below ten */
function human(bytes, base) {
  const suffixes = base === 1000 ? ['', 'k', 'M', 'G', 'T', 'P', 'E'] : ['', 'K', 'M', 'G', 'T', 'P', 'E']
  if (bytes < base) return String(bytes)
  let value = bytes
  let unit = 0
  while (value >= base && unit < suffixes.length - 1) { value /= base; unit++ }
  const tenths = Math.ceil(value * 10 - 1e-9)
  if (tenths < 100) return `${Math.floor(tenths / 10)}.${tenths % 10}${suffixes[unit]}`
  const whole = Math.ceil(value - 1e-9)
  if (whole >= base && unit < suffixes.length - 1) return `1.0${suffixes[unit + 1]}`
  return `${whole}${suffixes[unit]}`
}

const kindOf = mode => mode & S_IFMT

function readNames(path) {
  const bytes = path === '-' ? (() => {
    const chunks = []
    const buffer = new Uint8Array(65536)
    for (;;) { const n = sys.read(0, buffer, -1); if (n <= 0) break; chunks.push(buffer.slice(0, n)) }
    return joinChunks(chunks)
  })() : readFileBytes(path)
  return new TextDecoder().decode(bytes).split('\0').filter(Boolean)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: '0abB:cDd:HhkLlmPSst:xX:',
    long: {
      null: '0', all: 'a', 'apparent-size': 'A', 'block-size': { key: 'B', arg: 'required' }, bytes: 'b', total: 'c',
      'dereference-args': 'D', 'max-depth': { key: 'd', arg: 'required' }, 'files0-from': { key: 'F', arg: 'required' },
      'human-readable': 'h', inodes: 'I', dereference: 'L', 'count-links': 'l', 'no-dereference': 'P', 'separate-dirs': 'S',
      si: 'si', summarize: 's', threshold: { key: 't', arg: 'required' }, time: { key: 'T', arg: 'optional' },
      'time-style': { key: 'Y', arg: 'required' }, 'exclude-from': { key: 'X', arg: 'required' },
      exclude: { key: 'E', arg: 'required' }, 'one-file-system': 'x', help: 'help', version: 'V'
    }
  })
  if (error) { err(error); hint(); return 1 }

  const settings = {
    all: false, apparent: false, total: false, summarize: false, depth: Infinity, human: 0, scale: 1024, inodes: false,
    count: false, separate: false, oneFs: false, follow: 'P', terminator: '\n', threshold: undefined, time: undefined,
    timeStyle: undefined
  }
  const excludes = []
  let files0
  for (const [key, value] of options) {
    switch (key) {
      case '0': settings.terminator = '\0'; break
      case 'a': settings.all = true; break
      case 'A': settings.apparent = true; break
      case 'b': settings.apparent = true; settings.human = 0; settings.scale = 1; break
      case 'B': {
        const size = parseSize(String(value))
        if (size === undefined || size <= 0) { err(`invalid -B argument '${value}'`); return 1 }
        settings.scale = size; settings.human = 0
        break
      }
      case 'c': settings.total = true; break
      case 'D': case 'H': settings.follow = 'D'; break
      case 'd': {
        if (!/^\d+$/.test(String(value))) { err(`invalid maximum depth '${value}'`); return 1 }
        settings.depth = Number(value)
        break
      }
      case 'F': files0 = String(value); break
      case 'h': settings.human = 1024; break
      case 'si': settings.human = 1000; break
      case 'I': settings.inodes = true; break
      case 'k': settings.scale = 1024; settings.human = 0; break
      case 'L': settings.follow = 'L'; break
      case 'l': settings.count = true; break
      case 'm': settings.scale = 1024 * 1024; settings.human = 0; break
      case 'P': settings.follow = 'P'; break
      case 'S': settings.separate = true; break
      case 's': settings.summarize = true; break
      case 't': {
        const size = parseSize(String(value))
        if (size === undefined) { err(`invalid -t argument '${value}'`); return 1 }
        settings.threshold = size
        break
      }
      case 'T': {
        const which = value === true ? 'mtime' : String(value)
        const kind = { mtime: 'mtime', modification: 'mtime', atime: 'atime', access: 'atime', use: 'atime', ctime: 'ctime', status: 'ctime' }[which]
        if (!kind) { err(`invalid argument '${which}' for '--time'`); hint(); return 1 }
        settings.time = kind
        break
      }
      case 'Y': settings.timeStyle = String(value); break
      case 'X': {
        try { excludes.push(...new TextDecoder().decode(readFileBytes(resolve(getcwd(), String(value)))).split('\n').filter(Boolean)) } catch (e) {
          err(`${value}: ${reasonOf(e)}`); return 1
        }
        break
      }
      case 'E': excludes.push(String(value)); break
      case 'x': settings.oneFs = true; break
      case 'help': out(usage); return 0
      case 'V': out('du (ecmaOS coreutils) 1.0\n'); return 0
    }
  }
  if (settings.summarize) {
    if (settings.depth !== Infinity && settings.depth !== 0) { err('warning: summarizing conflicts with --max-depth=' + settings.depth); return 1 }
    settings.depth = 0
  }
  if (settings.summarize && settings.all) { err('cannot both summarize and show all entries'); return 1 }

  const cwd = getcwd()
  const matchers = excludes.map(pattern => compileGlob(pattern))
  const excluded = (name, path) => {
    for (const test of matchers) {
      if (test(name) || test(path)) return true
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) if (test(parts.slice(i).join('/'))) return true
    }
    return false
  }

  let names = [...operands]
  if (files0 !== undefined) {
    if (names.length) { err(`extra operand '${names[0]}'`); err("file operands cannot be combined with --files0-from"); hint(); return 1 }
    try { names = readNames(files0 === '-' ? '-' : resolve(cwd, files0)) } catch (e) { err(`cannot open '${files0}' for reading: ${reasonOf(e)}`); return 1 }
  } else if (names.length === 0) names = ['.']

  const utc = env?.TZ !== undefined && /^(UTC|GMT|UCT)(0)?$/.test(env.TZ)
  const formatTime = ms => {
    const style = settings.timeStyle ?? 'long-iso'
    const format = style === 'full-iso' ? '%Y-%m-%d %H:%M:%S.%N %z' : style === 'iso' ? '%Y-%m-%d' : style.startsWith('+') ? style.slice(1) : '%Y-%m-%d %H:%M'
    return strftime(format, { ms, utc })
  }

  const scaleOf = amount => {
    if (settings.inodes) return String(amount)
    if (settings.human) return human(amount, settings.human)
    return String(Math.ceil(amount / settings.scale))
  }
  const sizeOf = info => {
    if (settings.inodes) return 1
    if (settings.apparent) return kindOf(info.mode) === S_IFDIR ? 0 : Number(info.size ?? 0)
    const kind = kindOf(info.mode)
    if (kind !== S_IFREG) return 0
    return Math.ceil(Number(info.size ?? 0) / BLOCK) * BLOCK
  }
  const stamp = info => Number((settings.time === 'atime' ? info.atimeMs : settings.time === 'ctime' ? info.ctimeMs : info.mtimeMs) ?? 0)

  let failed = false
  let grand = 0
  const seen = new Set()
  const rootDevice = new Map()

  const emit = (amount, latest, shown) => {
    if (settings.threshold !== undefined) {
      const limit = settings.threshold
      if (limit >= 0 ? amount < limit : amount > -limit) return
    }
    const when = settings.time !== undefined ? `${formatTime(latest)}\t` : ''
    out(`${scaleOf(amount)}\t${when}${shown}${settings.terminator}`)
  }

  /** @returns {{ size: number, latest: number }} what `path` and everything below it take */
  function walk(shown, path, depth, top) {
    let info
    try {
      const followed = settings.follow === 'L' || (settings.follow === 'D' && depth === 0)
      info = followed ? stat(path) : lstat(path)
    } catch (e) {
      err(`cannot access '${shown}': ${reasonOf(e)}`)
      failed = true
      return { size: 0, latest: 0, dir: false }
    }
    const kind = kindOf(info.mode)
    if (!settings.count && kind !== S_IFDIR && Number(info.nlink ?? 1) > 1) {
      const key = `${info.dev}:${info.ino}`
      if (seen.has(key)) return { size: 0, latest: 0, dir: false }
      seen.add(key)
    }
    if (depth === 0) rootDevice.set(top, info.dev)
    let size = sizeOf(info)
    let latest = stamp(info)
    if (kind === S_IFDIR) {
      let children = []
      try { children = readdir(path).filter(name => name !== '.' && name !== '..').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) } catch (e) {
        err(`cannot read directory '${shown}': ${reasonOf(e)}`)
        failed = true
      }
      for (const name of children) {
        const childShown = shown.endsWith('/') ? shown + name : `${shown}/${name}`
        if (excluded(name, childShown)) continue
        if (settings.oneFs) {
          let childInfo
          try { childInfo = lstat(join(path, name)) } catch { childInfo = undefined }
          if (childInfo && kindOf(childInfo.mode) === S_IFDIR && childInfo.dev !== rootDevice.get(top)) continue
        }
        const inside = walk(childShown, join(path, name), depth + 1, top)
        latest = Math.max(latest, inside.latest)
        if (!(settings.separate && inside.dir)) size += inside.size
      }
      if (depth <= settings.depth) emit(size, latest, shown)
      return { size, latest, dir: true }
    }
    if (depth <= settings.depth && (settings.all || depth === 0)) emit(size, latest, shown)
    return { size, latest, dir: false }
  }

  for (const name of names) {
    const result = walk(name, resolve(cwd, name), 0, name)
    grand += result.size
  }
  if (settings.total) out(`${scaleOf(grand)}\ttotal${settings.terminator}`)
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
