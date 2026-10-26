/** Find files by name in the database `updatedb` made. */

import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { compile } from './lib/fnmatch.mjs'
import { basename, resolve } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`locate: ${text}\n`))

const HEADER = '#ecmaos-locatedb 1'
const DEFAULT_DATABASE = '/var/lib/plocate/plocate.db'

const usage = `Usage: locate [OPTION]... PATTERN...

  -A, --all              print only names that match all the patterns
  -b, --basename         match only the file name part of a path
  -c, --count            print the number of matches instead of the matches
  -d, --database FILE    search FILE (default ${DEFAULT_DATABASE})
  -i, --ignore-case      ignore case
  -l, -n, --limit N      stop after N matches
  -0, --null             separate matches with NUL, not newline
  -r, --regexp REGEX     match a regular expression (no PATTERN needed)
      --regex            read each PATTERN as a regular expression
  -w, --wholename        match the whole path (the default)
      --help             display this help and exit
      --version          output version information and exit

A PATTERN with * ? or [ must match the whole name (or file name with -b); any other is a part of it.
The database comes from updatedb.`

/** A test for one pattern: a glob when it has glob characters, otherwise a part of the name */
function matcher(pattern, { regex, ignoreCase }) {
  if (regex) {
    let re
    try { re = new RegExp(pattern, ignoreCase ? 'i' : '') } catch (e) { err(`invalid regular expression ‘${pattern}’: ${e.message}`); exit(2) }
    return name => re.test(name)
  }
  if (/[*?[]/.test(pattern)) return compile(pattern, { caseFold: ignoreCase })
  const wanted = ignoreCase ? pattern.toLowerCase() : pattern
  return name => (ignoreCase ? name.toLowerCase() : name).includes(wanted)
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'Abcd:il:n:0r:w',
    long: { all: 'A', basename: 'b', count: 'c', database: { key: 'd', arg: 'required' }, 'ignore-case': 'i', limit: { key: 'l', arg: 'required' }, null: '0', regexp: { key: 'r', arg: 'required' }, regex: 'regex', wholename: 'w', help: 'help', version: 'version' }
  })
  if (error) { err(error); return 2 }
  let all = false, base = false, count = false, ignoreCase = false, nul = false, regex = false, limit = Infinity
  let database = DEFAULT_DATABASE
  const patterns = [...operands]
  for (const [key, value] of options) {
    if (key === 'help') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('locate (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'A') all = true
    else if (key === 'b') base = true
    else if (key === 'w') base = false
    else if (key === 'c') count = true
    else if (key === 'd') database = resolve(getcwd(), value)
    else if (key === 'i') ignoreCase = true
    else if (key === '0') nul = true
    else if (key === 'regex') regex = true
    else if (key === 'r') { regex = true; patterns.push(value) }
    else if (key === 'l' || key === 'n') {
      if (!/^\d+$/.test(value)) { err(`invalid limit ‘${value}’`); return 2 }
      limit = Number(value)
    }
  }
  if (!patterns.length) { err('no pattern to search for specified'); return 2 }

  let text
  try { text = readTextFile(database) } catch (e) { err(`${database}: ${reasonOf(e)}${e?.code === 'ENOENT' || /ENOENT/.test(String(e)) ? ' (run updatedb)' : ''}`); return 2 }
  if (!text.startsWith(HEADER + '\n')) { err(`${database}: not a locate database (run updatedb)`); return 2 }

  const tests = patterns.map(pattern => matcher(pattern, { regex, ignoreCase }))
  const terminator = nul ? '\0' : '\n'
  let found = 0
  for (const path of text.slice(HEADER.length + 1).split('\n')) {
    if (!path) continue
    const subject = base ? basename(path) : path
    if (!(all ? tests.every(test => test(subject)) : tests.some(test => test(subject)))) continue
    found++
    if (!count) out(path + terminator)
    if (found >= limit) break
  }
  if (count) out(`${found}\n`)
  return found ? 0 : 1
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(2)
}
