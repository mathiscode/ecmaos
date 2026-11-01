/**
 * `envsubst`: copy standard input to standard output, replacing `$VAR` and `${VAR}` with the environment's values (an unset
 * variable is empty). With a SHELL-FORMAT such as `'$HOME $USER'` only those variables are replaced; `-v` lists the variables a
 * format (or, without one, the input) refers to.
 */

import { readAll } from './lib/run.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`envsubst: ${text}\n`))

const usage = `Usage: envsubst [OPTION] [SHELL-FORMAT]
Substitutes the values of environment variables.

Operation mode:
  -v, --variables             output the variables occurring in SHELL-FORMAT
Informative output:
  -h, --help                  display this help and exit
  -V, --version               output version information and exit

In normal operation mode, standard input is copied to standard output,
with references to environment variables of the form $VARIABLE or \${VARIABLE}
being replaced with the corresponding values.  If a SHELL-FORMAT is given,
only those environment variables that are referenced in SHELL-FORMAT are
substituted; otherwise all environment variables references occurring in
standard input are substituted.`

const reference = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
const names = text => [...text.matchAll(reference)].map(match => match[1] ?? match[2])

async function main() {
  const args = argv.slice(1)
  let list = false
  const operands = []
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '-V' || arg === '--version') { out('envsubst (ecmaOS coreutils) 1.0\n'); return 0 }
    if (arg === '-v' || arg === '--variables') list = true
    else if (arg.startsWith('-') && arg !== '-') { err(`invalid option -- '${arg.replace(/^-+/, '')}'\nTry 'envsubst --help' for more information.`); return 1 }
    else operands.push(arg)
  }
  if (operands.length > 1) { err('too many arguments\nTry \'envsubst --help\' for more information.'); return 1 }
  const format = operands[0]
  if (list && format === undefined) { err('missing arguments\nTry \'envsubst --help\' for more information.'); return 1 }
  if (list) { for (const name of new Set(names(format))) out(name + '\n'); return 0 }

  const allowed = format === undefined ? undefined : new Set(names(format))
  const text = new TextDecoder().decode(readAll(0))
  out(text.replace(reference, (whole, braced, bare) => {
    const name = braced ?? bare
    return allowed && !allowed.has(name) ? whole : env[name] ?? ''
  }))
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
