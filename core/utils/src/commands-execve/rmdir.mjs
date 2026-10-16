/**
 * Remove empty directories, as GNU `rmdir` does: a directory with anything in it, or a file, is refused rather than
 * removed. `-p` also removes each parent in turn, `--ignore-fail-on-non-empty` quiets the non-empty case, `-v` reports.
 */

import { resolve } from './lib/path-utils.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, is } from './lib/errno.mjs'

const { argv, exit, writeAll, getcwd, rmdir } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`rmdir: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('rmdir') + '\n'))

const usage = `Usage: rmdir [OPTION]... DIRECTORY...
Remove the DIRECTORY(ies), if they are empty.

      --ignore-fail-on-non-empty
                  ignore each failure that is solely because a directory
                    is non-empty
  -p, --parents   remove DIRECTORY and its ancestors; e.g., 'rmdir -p a/b' is
                    similar to 'rmdir a/b a'
  -v, --verbose   output a diagnostic for every directory processed
      --help      display this help and exit`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'pv',
    long: { parents: 'p', verbose: 'v', 'ignore-fail-on-non-empty': 'i', help: 'h' }
  })
  if (error) { err(error); hint(); return 1 }
  const has = key => options.some(([k]) => k === key)
  if (has('h')) { out(usage + '\n'); return 0 }
  if (operands.length === 0) { err('missing operand'); hint(); return 1 }

  const parents = has('p')
  const verbose = has('v')
  const ignoreNonEmpty = has('i')
  const cwd = getcwd()
  let failed = false

  const remove = (name, display) => {
    if (verbose) out(`rmdir: removing directory, '${display}'\n`)
    try {
      rmdir(resolve(cwd, name))
      return true
    } catch (error) {
      if (ignoreNonEmpty && (is(error, 'ENOTEMPTY') || is(error, 'EEXIST'))) return false
      err(`failed to remove '${display}': ${reasonOf(error)}`)
      failed = true
      return false
    }
  }

  for (const operand of operands) {
    if (!remove(operand, operand) || !parents) continue
    // Each parent that is named, up to but not including the root or the current directory
    let path = operand.replace(/\/+$/, '')
    for (;;) {
      const slash = path.lastIndexOf('/')
      if (slash <= 0) break
      path = path.slice(0, slash).replace(/\/+$/, '')
      if (!path || !remove(path, path)) break
    }
  }
  return failed ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
