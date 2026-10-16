/**
 * Print the environment, or run a command in a modified one, as GNU `env` does. Options come first (`-i` or `-` for an
 * empty environment, `-u NAME`, `-C DIR`, `-S STRING` to split a string into arguments, `-v`, `-0`), then
 * `NAME=VALUE` words, then the command. The command is a program found along the new `PATH`, never a shell builtin.
 * It is the program behind `/usr/bin/env`, which `#!/usr/bin/env bash` scripts name.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, env, exit, writeAll, stat, spawn, waitpid, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`env: ${text}\n`))
const hint = () => writeAll(2, encoder.encode(tryHelp('env') + '\n'))
const quote = text => `‘${text}’`

const usage = `Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]
Set each NAME to VALUE in the environment and run COMMAND.

Mandatory arguments to long options are mandatory for short options too.
  -i, --ignore-environment  start with an empty environment
  -0, --null           end each output line with NUL, not newline
  -u, --unset=NAME     remove variable from the environment
  -C, --chdir=DIR      change working directory to DIR
  -S, --split-string=S  process and split S into separate arguments;
                        used to pass multiple arguments on shebang lines
  -v, --debug          print verbose information for each processing step
      --help        display this help and exit
      --version     output version information and exit

A mere - implies -i.  If no COMMAND, print the resulting environment.
`

/** The words of a `-S` string: whitespace separates, quotes and backslashes group, `$NAME` expands, `#` comments */
function splitString(text, vars) {
  const words = []
  let word
  let i = 0
  const push = () => { if (word !== undefined) { words.push(word); word = undefined } }
  const expand = () => {
    const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(text.slice(i))
    if (!match) return false
    word = (word ?? '') + (vars[match[1]] ?? '')
    i += match[0].length
    return true
  }
  while (i < text.length) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r') { push(); i++; continue }
    if (c === '#' && word === undefined) break
    if (c === '\'') {
      const close = text.indexOf('\'', i + 1)
      if (close === -1) return { error: `no terminating quote in -S string` }
      word = (word ?? '') + text.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (c === '"') {
      i++
      word = word ?? ''
      for (;;) {
        if (i >= text.length) return { error: `no terminating quote in -S string` }
        const d = text[i]
        if (d === '"') { i++; break }
        if (d === '\\') {
          const e = text[i + 1]
          if (e === undefined) return { error: `invalid backslash at end of string in -S` }
          const mapped = { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', a: '\x07', '_': ' ', '"': '"', '\\': '\\', '$': '$' }[e]
          if (mapped === undefined) return { error: `invalid sequence '\\${e}' in -S` }
          word += mapped
          i += 2
          continue
        }
        if (d === '$' && expand()) continue
        word += d
        i++
      }
      continue
    }
    if (c === '\\') {
      const e = text[i + 1]
      if (e === undefined) return { error: `invalid backslash at end of string in -S` }
      if (e === 'c') break
      if (e === '_') { push(); i += 2; continue }
      const mapped = { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', a: '\x07', '#': '#', '$': '$', '"': '"', '\'': '\'', '\\': '\\' }[e]
      if (mapped === undefined) return { error: `invalid sequence '\\${e}' in -S` }
      word = (word ?? '') + mapped
      i += 2
      continue
    }
    if (c === '$' && expand()) continue
    word = (word ?? '') + c
    i++
  }
  push()
  return { words }
}

/** Replaces each `-S STRING` among the leading options with the words it splits into */
function spliceSplitStrings(args, vars) {
  const result = []
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--' || !arg.startsWith('-') || arg === '-') break
    let text
    if (arg === '-S' || arg === '--split-string') text = args[++i]
    else if (arg.startsWith('--split-string=')) text = arg.slice(15)
    else if (/^-S./.test(arg) && !arg.startsWith('--')) text = arg.slice(2)
    else {
      result.push(arg)
      if (arg === '--unset' || arg === '--chdir' || (!arg.startsWith('--') && /^-[^-]*[uC]$/.test(arg))) result.push(args[++i])
      continue
    }
    if (text === undefined) return { error: "option requires an argument -- 'S'", usage: true }
    const split = splitString(text, vars)
    if (split.error) return { error: split.error }
    result.push(...split.words)
  }
  result.push(...args.slice(i))
  return { args: result }
}

function findProgram(name, path) {
  const usable = candidate => {
    try {
      const info = stat(candidate)
      return (info.mode & 0xf000) === 0x8000 ? ((info.mode & 0o111) !== 0 ? 'ok' : 'denied') : 'no'
    } catch { return 'no' }
  }
  if (name.includes('/')) { const state = usable(name); return state === 'no' ? { missing: true } : { program: name, denied: state === 'denied' } }
  let denied
  for (const dir of path.split(':')) {
    const candidate = `${dir || '.'}/${name}`
    const state = usable(candidate)
    if (state === 'ok') return { program: candidate }
    if (state === 'denied') denied ??= candidate
  }
  return denied ? { program: denied, denied: true } : { missing: true }
}

async function main() {
  let vars = { ...env }
  const spliced = spliceSplitStrings(argv.slice(1), vars)
  if (spliced.error) { err(spliced.error); if (spliced.usage) hint(); return 125 }
  const { options, operands, error } = getopt(spliced.args, {
    short: 'iu:0C:S:v',
    long: {
      'ignore-environment': 'i', unset: { key: 'u', arg: 'required' }, null: '0', chdir: { key: 'C', arg: 'required' },
      'split-string': { key: 'S', arg: 'required' }, debug: 'v', help: 'help', version: 'version'
    },
    permute: false
  })
  if (error) { err(error); hint(); return 125 }

  let nullEnd = false
  let debug = false
  let chdir
  const unsets = []
  let clean = false
  for (const [key, value] of options) {
    if (key === 'help') { out(usage); return 0 }
    if (key === 'version') { out('env (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'i') clean = true
    else if (key === '0') nullEnd = true
    else if (key === 'v') debug = true
    else if (key === 'C') chdir = String(value)
    else if (key === 'u') unsets.push(String(value))
  }
  const rest = [...operands]
  if (rest[0] === '-') { clean = true; rest.shift() }

  if (clean) { vars = {}; if (debug) writeAll(2, encoder.encode('cleaning environ\n')) }
  for (const name of unsets) {
    if (name === '' || name.includes('=')) { err(`cannot unset ${quote(name)}: Invalid argument`); return 125 }
    if (debug) writeAll(2, encoder.encode(`unset:    ${name}\n`))
    delete vars[name]
  }
  while (rest.length) {
    const eq = rest[0].indexOf('=')
    if (eq <= 0) break
    const word = rest.shift()
    if (debug) writeAll(2, encoder.encode(`setenv:   ${word}\n`))
    vars[word.slice(0, eq)] = word.slice(eq + 1)
  }

  if (rest.length === 0) {
    if (chdir !== undefined) { err('must specify command with --chdir (-C)'); hint(); return 125 }
    out(Object.entries(vars).map(([name, value]) => `${name}=${value}${nullEnd ? '\0' : '\n'}`).join(''))
    return 0
  }
  if (nullEnd) { err('cannot specify --null (-0) with command'); hint(); return 125 }

  let cwd = getcwd()
  if (chdir !== undefined) {
    const target = resolve(cwd, chdir)
    try {
      if ((stat(target).mode & 0xf000) !== 0x4000) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
    } catch (e) {
      err(`cannot change directory to ${quote(chdir)}: ${e?.code === 'ENOTDIR' ? 'Not a directory' : 'No such file or directory'}`)
      return 125
    }
    if (debug) writeAll(2, encoder.encode(`chdir:    ${target}\n`))
    cwd = target
  }

  const found = findProgram(rest[0], vars.PATH ?? '/bin:/usr/bin')
  if (found.missing) { err(`${quote(rest[0])}: No such file or directory`); return 127 }
  if (found.denied) { err(`${quote(rest[0])}: Permission denied`); return 126 }
  if (debug) {
    writeAll(2, encoder.encode(`executing: ${rest[0]}\n`))
    rest.forEach((word, index) => writeAll(2, encoder.encode(`   arg[${index}]= ${quote(word)}\n`)))
  }
  const pid = await spawn(found.program, rest, { env: vars, fds: { 0: 0, 1: 1, 2: 2 }, cwd })
  const done = await waitpid(pid, false)
  return done.signal ? 128 + done.signal : done.code
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(125)
}
