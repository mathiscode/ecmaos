/** `gzip`, `gunzip` and `zcat`: the platform's gzip streams behind the usual command lines. */

import { readFdBytes, readFileBytes, writeFdBytes, writeFileBytes, joinChunks } from './bytes.mjs'
import { resolve } from './path-utils.mjs'

const { argv, exit, writeAll, getcwd, stat, unlink, lstat } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()

async function through(bytes, stream) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader()
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return joinChunks(chunks)
}

export const compress = bytes => through(bytes, new CompressionStream('gzip'))
export const decompress = bytes => through(bytes, new DecompressionStream('gzip'))

const exists = path => { try { stat(path); return true } catch { return false } }

/** `mode`: 'gzip', 'gunzip' or 'zcat', which decides the defaults. */
export async function main(mode) {
  const out = text => writeAll(1, encoder.encode(text))
  const err = text => writeAll(2, encoder.encode(`${mode}: ${text}\n`))
  const usage = mode === 'gzip'
    ? `Usage: gzip [OPTION]... [FILE]...
Compress FILEs (standard input by default) to FILE.gz, removing the original.

  -c, --stdout    write to standard output, keeping the original
  -d, --decompress  decompress
  -k, --keep      keep the original
  -f, --force     overwrite an existing output file
  -t, --test      check the integrity of compressed files
  -v, --verbose   say what is done
  -1 .. -9        accepted; the compression level is not adjustable here
  --help          display this help and exit`
    : `Usage: ${mode} [OPTION]... [FILE]...
Decompress FILEs (standard input by default)${mode === 'zcat' ? ' to standard output' : ', removing the .gz'}.

  -c, --stdout    write to standard output, keeping the original
  -k, --keep      keep the original
  -f, --force     overwrite an existing output file
  -t, --test      check the integrity of compressed files
  -v, --verbose   say what is done
  --help          display this help and exit`

  const o = { decompress: mode !== 'gzip', stdout: mode === 'zcat', keep: false, force: false, test: false, verbose: false }
  const files = []
  for (const arg of argv.slice(1)) {
    if (arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '--') continue
    if (arg === '-' || !arg.startsWith('-')) { files.push(arg); continue }
    if (arg.startsWith('--')) {
      if (arg === '--stdout' || arg === '--to-stdout') o.stdout = true
      else if (arg === '--decompress' || arg === '--uncompress') o.decompress = true
      else if (arg === '--keep') o.keep = true
      else if (arg === '--force') o.force = true
      else if (arg === '--test') { o.test = true; o.decompress = true }
      else if (arg === '--verbose') o.verbose = true
      else if (arg === '--fast' || arg === '--best' || arg === '--quiet') continue
      else { err(`unrecognized option '${arg}'`); return 1 }
      continue
    }
    for (const letter of arg.slice(1)) {
      if (letter === 'c') o.stdout = true
      else if (letter === 'd') o.decompress = true
      else if (letter === 'k') o.keep = true
      else if (letter === 'f') o.force = true
      else if (letter === 't') { o.test = true; o.decompress = true }
      else if (letter === 'v') o.verbose = true
      else if (/[1-9q]/.test(letter)) continue
      else { err(`invalid option -- '${letter}'`); return 1 }
    }
  }

  const cwd = getcwd()
  let status = 0
  const handle = async bytes => o.decompress ? await decompress(bytes) : await compress(bytes)

  if (files.length === 0) {
    try { writeFdBytes(1, await handle(readFdBytes(0))) } catch (error) { err(o.decompress ? 'stdin: not in gzip format' : error?.message ?? String(error)); return 1 }
    return 0
  }

  for (const file of files) {
    const path = resolve(cwd, file)
    try {
      if (file === '-') { writeFdBytes(1, await handle(readFdBytes(0))); continue }
      if ((lstat(path).mode & 0xf000) === 0x4000) { err(`${file}: is a directory -- ignored`); status = status || 2; continue }
      const suffixed = file.endsWith('.gz') || file.endsWith('.tgz')
      if (o.decompress && !suffixed && !o.stdout && !o.test) { err(`${file}: unknown suffix -- ignored`); status = status || 2; continue }
      if (!o.decompress && file.endsWith('.gz') && !o.stdout) { err(`${file} already has .gz suffix -- unchanged`); status = status || 2; continue }
      let result
      try { result = await handle(readFileBytes(path)) } catch (error) {
        err(o.decompress ? `${file}: not in gzip format` : `${file}: ${error?.message ?? error}`)
        status = 1
        continue
      }
      if (o.test) { if (o.verbose) out(`${file}:\t OK\n`); continue }
      if (o.stdout) { writeFdBytes(1, result); continue }
      const target = o.decompress ? (file.endsWith('.tgz') ? file.slice(0, -4) + '.tar' : file.slice(0, -3)) : file + '.gz'
      const targetPath = resolve(cwd, target)
      if (exists(targetPath) && !o.force) { err(`${target} already exists; not overwritten`); status = status || 2; continue }
      writeFileBytes(targetPath, result)
      if (!o.keep) unlink(path)
      if (o.verbose) out(`${file}:\t-- replaced with ${target}\n`)
    } catch (error) {
      err(`${file}: ${error?.message ?? error}`)
      status = 1
    }
  }
  return status
}

export async function start(mode) {
  try { exit(await main(mode)) } catch (error) {
    writeAll(2, encoder.encode(`${mode}: ${error?.message ?? String(error)}\n`))
    exit(1)
  }
}
