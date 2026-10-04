/** `md5sum`, `sha1sum`, `sha256sum`, `sha384sum` and `sha512sum`: one program, five algorithms. */

import { digestHex } from './digest.mjs'
import { readFdBytes, readFileBytes } from './bytes.mjs'
import { resolve } from './path-utils.mjs'

const { argv, exit, writeAll, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()

export async function checksum(name, algorithm) {
  const out = text => writeAll(1, encoder.encode(text))
  const err = text => writeAll(2, encoder.encode(`${name}: ${text}\n`))
  const usage = `Usage: ${name} [OPTION]... [FILE]...
Print or check ${algorithm.toUpperCase()} checksums. With no FILE, or when FILE is -, read standard input.

  -b, --binary   read in binary mode (the output marks it with a *)
  -t, --text     read in text mode (the default)
  -c, --check    read checksums from the FILEs and check them
  --tag          create a BSD-style checksum
  --quiet        when checking, do not print OK for each file that passes
  --status       when checking, print nothing: the status says whether they passed
  -w, --warn     accepted for compatibility
  --help         display this help and exit`

  const args = argv.slice(1)
  const o = { binary: false, check: false, tag: false, quiet: false, status: false }
  const files = []
  for (const arg of args) {
    if (arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '--') continue
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg.startsWith('--')) {
      if (arg === '--binary') o.binary = true
      else if (arg === '--text') o.binary = false
      else if (arg === '--check') o.check = true
      else if (arg === '--tag') o.tag = true
      else if (arg === '--quiet') o.quiet = true
      else if (arg === '--status') o.status = true
      else if (arg === '--warn') continue
      else { err(`unrecognized option '${arg}'`); return 1 }
      continue
    }
    for (const letter of arg.slice(1)) {
      if (letter === 'b') o.binary = true
      else if (letter === 't') o.binary = false
      else if (letter === 'c') o.check = true
      else if (letter === 'w') continue
      else { err(`invalid option -- '${letter}'`); return 1 }
    }
  }
  if (files.length === 0) files.push('-')
  const cwd = getcwd()
  const load = file => file === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, file))

  if (!o.check) {
    let failed = false
    for (const file of files) {
      try {
        const sum = await digestHex(algorithm, load(file))
        out(o.tag ? `${algorithm.toUpperCase()} (${file}) = ${sum}\n` : `${sum} ${o.binary ? '*' : ' '}${file}\n`)
      } catch (error) { err(`${file}: ${error?.message ?? error}`); failed = true }
    }
    return failed ? 1 : 0
  }

  let bad = 0
  let unreadable = 0
  let malformed = 0
  let checked = 0
  for (const list of files) {
    let text
    try { text = new TextDecoder().decode(load(list)) } catch (error) { err(`${list}: ${error?.message ?? error}`); unreadable++; continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const bsd = /^[A-Za-z0-9-]+ \((.*)\) = ([0-9a-fA-F]+)$/.exec(line)
      const gnu = /^([0-9a-fA-F]+) [ *](.*)$/.exec(line)
      const file = bsd ? bsd[1] : gnu?.[2]
      const expected = (bsd ? bsd[2] : gnu?.[1])?.toLowerCase()
      if (!file || !expected) { malformed++; continue }
      checked++
      let result
      try { result = (await digestHex(algorithm, load(file))) === expected ? 'OK' : 'FAILED' } catch { result = 'FAILED open or read'; unreadable++ }
      if (result !== 'OK') bad++
      if (!o.status && !(o.quiet && result === 'OK')) out(`${file}: ${result}\n`)
    }
  }
  if (!o.status) {
    if (malformed) err(`WARNING: ${malformed} line${malformed === 1 ? ' is' : 's are'} improperly formatted`)
    if (unreadable) err(`WARNING: ${unreadable} listed file${unreadable === 1 ? '' : 's'} could not be read`)
    if (bad) err(`WARNING: ${bad} computed checksum${bad === 1 ? '' : 's'} did NOT match`)
  }
  return checked === 0 || bad || unreadable ? 1 : 0
}

export async function start(name, algorithm) {
  try { exit(await checksum(name, algorithm)) } catch (error) {
    writeAll(2, encoder.encode(`${name}: ${error?.message ?? String(error)}\n`))
    exit(1)
  }
}
