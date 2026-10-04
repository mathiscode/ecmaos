/**
 * Build command lines from standard input and run them: `find . -name '*.tmp' | xargs rm`.
 *
 * Input is split at blanks and newlines, with quotes and backslashes honoured; `-0` and `-d` split at one
 * character instead. The arguments are given to as few runs of the command as the size limit allows, or
 * `-n` at a time, or one line at a time with `-I`. The command runs with no standard input of its own.
 */

import { findProgram, openDevNull, readAll, run } from './lib/run.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`xargs: ${text}\n`))

const usage = `Usage: xargs [OPTION]... [COMMAND [INITIAL-ARGS]...]
Run COMMAND with arguments read from standard input (echo by default).

  -0, --null             items end with a NUL, not blanks or newlines
  -d, --delimiter=CHAR   items end with CHAR
  -n, --max-args=N       at most N arguments per command line
  -L, --max-lines=N      at most N input lines per command line
  -I REPLACE             run once per input line, replacing REPLACE in the arguments with it
  -i                     the same as -I {}
  -r, --no-run-if-empty  do not run the command when there is no input
  -s, --max-chars=N      at most N characters per command line
  -P, --max-procs=N      run up to N commands at a time (default 1)
  -t, --verbose          print each command line on standard error before running it
  -x, --exit             stop if a command line cannot fit within the size limit
  --help                 display this help and exit

The status is 0 when every command succeeded, 123 when one exited 1-125, 124 when one exited 255,
125 when one was killed by a signal, 126 when the command cannot run, and 127 when it is not found.`

/** Splits blank-separated input, where quotes and backslashes group and escape, into lines of items. */
function splitBlanks(text) {
  const lines = []
  let items = []
  let current = ''
  let started = false
  let quote
  const endItem = () => { if (started) { items.push(current); current = ''; started = false } }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\n') throw new Error('unmatched ' + (quote === '"' ? 'double' : 'single') + ' quote; by default quotes are special to xargs unless you use the -0 option')
      else current += c
    } else if (c === "'" || c === '"') { quote = c; started = true }
    else if (c === '\\' && i + 1 < text.length) { current += text[++i]; started = true }
    else if (c === '\n') { endItem(); lines.push(items); items = [] }
    else if (c === ' ' || c === '\t') endItem()
    else { current += c; started = true }
  }
  if (quote) throw new Error('unmatched ' + (quote === '"' ? 'double' : 'single') + ' quote; by default quotes are special to xargs unless you use the -0 option')
  endItem()
  if (items.length) lines.push(items)
  return lines.filter(line => line.length)
}

function parse(args) {
  const o = { command: [], delimiter: undefined, maxArgs: undefined, maxLines: undefined, replace: undefined, noRun: false, maxChars: 131072, procs: 1, verbose: false, exitOnLimit: false }
  let i = 0
  const value = (name, inline) => { if (inline !== undefined) return inline; if (i + 1 >= args.length) throw new Error(`option requires an argument -- '${name}'`); return args[++i] }
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (arg === '--help') { o.help = true; return o }
    if (!arg.startsWith('-') || arg === '-') break
    let m
    if (arg === '-0' || arg === '--null') o.delimiter = '\0'
    else if ((m = /^--delimiter(?:=(.*))?$/.exec(arg)) || arg.startsWith('-d')) {
      const text = m ? value('d', m[1]) : (arg.length > 2 ? arg.slice(2) : value('d'))
      o.delimiter = text === '\\n' ? '\n' : text === '\\t' ? '\t' : text === '\\0' ? '\0' : text
      if (o.delimiter.length !== 1) throw new Error(`${text}: delimiter must be a single character`)
    }
    else if ((m = /^--max-args(?:=(.*))?$/.exec(arg)) || arg.startsWith('-n')) o.maxArgs = Number(m ? value('n', m[1]) : (arg.length > 2 ? arg.slice(2) : value('n')))
    else if ((m = /^--max-lines(?:=(.*))?$/.exec(arg)) || arg.startsWith('-L')) o.maxLines = Number(m ? value('L', m[1]) : (arg.length > 2 ? arg.slice(2) : value('L')))
    else if (arg.startsWith('-I')) o.replace = arg.length > 2 ? arg.slice(2) : value('I')
    else if (arg === '-i' || arg.startsWith('--replace')) o.replace = arg.includes('=') ? arg.split('=')[1] : '{}'
    else if ((m = /^--max-chars(?:=(.*))?$/.exec(arg)) || arg.startsWith('-s')) o.maxChars = Number(m ? value('s', m[1]) : (arg.length > 2 ? arg.slice(2) : value('s')))
    else if ((m = /^--max-procs(?:=(.*))?$/.exec(arg)) || arg.startsWith('-P')) o.procs = Number(m ? value('P', m[1]) : (arg.length > 2 ? arg.slice(2) : value('P')))
    else if (arg === '-r' || arg === '--no-run-if-empty') o.noRun = true
    else if (arg === '-t' || arg === '--verbose') o.verbose = true
    else if (arg === '-x' || arg === '--exit') o.exitOnLimit = true
    else throw new Error(`invalid option -- '${arg.replace(/^-+/, '')}'`)
  }
  for (const [name, n] of [['max-args', o.maxArgs], ['max-lines', o.maxLines], ['max-procs', o.procs], ['max-chars', o.maxChars]]) {
    if (n !== undefined && (!Number.isInteger(n) || n < (name === 'max-procs' ? 0 : 1))) throw new Error(`invalid number for --${name}`)
  }
  o.command = args.slice(i)
  return o
}

async function main() {
  let o
  try { o = parse(argv.slice(1)) } catch (error) { err(error.message); return 1 }
  if (o.help) { writeAll(1, encoder.encode(usage + '\n')); return 0 }

  const text = new TextDecoder().decode(readAll(0))
  let lines
  try {
    if (o.delimiter !== undefined) {
      const parts = text.split(o.delimiter)
      if (parts[parts.length - 1] === '') parts.pop()
      lines = parts.map(item => [item])
    } else lines = splitBlanks(text)
  } catch (error) { err(error.message); return 1 }
  const items = lines.flat()
  if (items.length === 0 && o.noRun) return 0

  const base = o.command.length ? o.command : ['echo']
  // the command lines to run: one per input line with -I, `-n` or `-L` items at a time, else as many as fit
  const batches = []
  if (o.replace !== undefined) {
    for (const line of o.delimiter !== undefined ? items.map(item => [item]) : lines.map(line => [line.join(' ')])) batches.push(line[0])
  } else if (o.maxLines !== undefined && o.delimiter === undefined) {
    for (let i = 0; i < lines.length; i += o.maxLines) batches.push(lines.slice(i, i + o.maxLines).flat())
  } else {
    let batch = []
    let size = base.join(' ').length
    for (const item of items) {
      const cost = item.length + 1
      if (cost + base.join(' ').length > o.maxChars) { err('argument line too long'); return 1 }
      if (batch.length && (size + cost > o.maxChars || (o.maxArgs !== undefined && batch.length >= o.maxArgs))) { batches.push(batch); batch = []; size = base.join(' ').length }
      batch.push(item)
      size += cost
    }
    if (batch.length || items.length === 0) batches.push(batch)
  }

  const program = findProgram(base[0])
  if (!program) { err(`${base[0]}: No such file or directory`); return 127 }

  let worst = 0
  const note = status => { if (status === 255) worst = Math.max(worst, 124); else if (status >= 128) worst = Math.max(worst, 125); else if (status !== 0) worst = Math.max(worst, 123) }
  const stdin = openDevNull()
  let stop = false
  const runBatch = async batch => {
    if (stop) return
    const argvOut = o.replace !== undefined ? base.map(word => word.split(o.replace).join(batch)) : [...base, ...batch]
    if (o.verbose) writeAll(2, encoder.encode(argvOut.join(' ') + '\n'))
    let result
    try { result = await run(program, argvOut, { fds: { 0: stdin, 1: 1, 2: 2 } }) } catch (error) { err(`${base[0]}: ${error?.message ?? error}`); worst = Math.max(worst, 126); return }
    if (result.signal) { err(`${base[0]}: terminated by signal ${result.signal}`); worst = Math.max(worst, 125); stop = true; return }
    note(result.status)
    // exit status 255 tells xargs to stop at once
    if (result.status === 255) stop = true
  }

  const width = Math.max(1, o.procs || batches.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(width, batches.length) }, async () => {
    while (next < batches.length && !stop) await runBatch(batches[next++])
  }))
  return worst
}

try {
  exit(await main())
} catch (error) {
  err(error?.message ?? String(error))
  exit(1)
}
