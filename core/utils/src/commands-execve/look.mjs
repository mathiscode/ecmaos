/** `look`: print the lines of a sorted file that begin with a string. The default file is the word list, `/usr/share/dict/words`. */

import { getopt } from './lib/getopt.mjs'
import { readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`look: ${text}\n`))

const usage = `Usage:
 look [options] <string> [<file>...]

Display lines beginning with a specified string.

Options:
 -a, --alternative        use the alternative dictionary
 -d, --alphanum           compare only blanks and alphanumeric characters
 -f, --ignore-case        ignore case differences when comparing
 -t, --terminate <char>   define the string-termination character
 -h, --help               display this help
 -V, --version            display version`

function main() {
  const parsed = getopt(argv.slice(1), {
    short: 'adft:hV',
    long: { alternative: 'a', alphanum: 'd', 'ignore-case': 'f', terminate: { key: 't', arg: 'required' }, help: 'h', version: 'V' }
  })
  if (parsed.error) { err(parsed.error); err("Try 'look --help' for more information."); return 2 }
  const flags = new Map(parsed.options)
  if (flags.has('h')) { out(usage + '\n'); return 0 }
  if (flags.has('V')) { out('look from ecmaOS coreutils\n'); return 0 }
  if (!parsed.operands.length) { out(usage + '\n'); return 2 }

  const fold = flags.has('f')
  const alnum = flags.has('d')
  const terminate = typeof flags.get('t') === 'string' ? flags.get('t') : undefined
  const normalise = line => {
    let value = line
    if (alnum) value = value.replace(/[^A-Za-z0-9 \t]/g, '')
    return fold ? value.toLowerCase() : value
  }

  let needle = parsed.operands[0]
  if (terminate !== undefined) { const at = needle.indexOf(terminate); if (at !== -1) needle = needle.slice(0, at + 1) }
  needle = normalise(needle)

  const files = parsed.operands.length > 1 ? parsed.operands.slice(1) : [flags.has('a') ? '/usr/share/dict/web2' : '/usr/share/dict/words']
  let status = 1
  for (const file of files) {
    let content
    try { content = readTextFile(file) } catch { err(`${file}: No such file or directory`); return 2 }
    let lines = content.split('\n')
    if (lines[lines.length - 1] === '') lines = lines.slice(0, -1)
    for (const line of lines) {
      let key = line
      if (terminate !== undefined) { const at = key.indexOf(terminate); if (at !== -1) key = key.slice(0, at + 1) }
      if (normalise(key).startsWith(needle)) { out(line + '\n'); status = 0 }
    }
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
