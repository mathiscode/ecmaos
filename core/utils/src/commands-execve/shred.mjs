/**
 * `shred`: overwrite files so their contents are hard to recover, then optionally remove them, as GNU shred does. Each
 * pass writes the file's length of random bytes (`-n` passes, 3 by default), `-z` adds a last pass of zeros, and `-u`
 * truncates the file, renames it to shorter and shorter names of zeros, and removes it. As GNU's page warns of
 * journaling filesystems, the IndexedDB a browser keeps the files in may hold old copies of what was overwritten, so
 * this is a best effort.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf, quotef } from './lib/errno.mjs'
import { parseSize } from './lib/size.mjs'

const { argv, exit, writeAll, open, close, stat, rename, unlink, custom, O_WRONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const say = text => writeAll(2, encoder.encode(`shred: ${text}\n`))

const usage = `Usage: shred [OPTION]... FILE...
Overwrite the specified FILE(s) repeatedly, in order to make it harder
for even very expensive hardware probing to recover the data.

If FILE is -, shred standard output.

  -f, --force    change permissions to allow writing if necessary
  -n, --iterations=N  overwrite N times instead of the default (3)
      --random-source=FILE  get random bytes from FILE
  -s, --size=N   shred this many bytes (suffixes like K, M, G accepted)
  -u             deallocate and remove file after overwriting
      --remove[=HOW]  like -u but give control on HOW to delete;  See below
  -v, --verbose  show progress
  -x, --exact    do not round file sizes up to the next full block;
                   this is the default for non-regular files
  -z, --zero     add a final overwrite with zeros to hide shredding
      --help        display this help and exit
      --version     output version information and exit`

const BLOCK = 4096

async function pass(fd, size, fill) {
  const chunk = new Uint8Array(Math.min(size, 65536))
  let done = 0
  while (done < size) {
    const length = Math.min(chunk.length, size - done)
    if (fill === 'random') crypto.getRandomValues(chunk.subarray(0, length))
    else chunk.fill(0)
    writeAll(fd, chunk.subarray(0, length), done)
    done += length
  }
  await custom('fsync', fd).catch(() => {})
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'fn:s:uvxz',
    long: { force: 'f', iterations: { key: 'n', arg: 'required' }, 'random-source': { key: 'random', arg: 'required' }, size: { key: 's', arg: 'required' }, remove: { key: 'remove', arg: 'optional' }, verbose: 'v', exact: 'x', zero: 'z', help: 'help', version: 'version' }
  })
  if (error) { say(error); writeAll(2, encoder.encode(tryHelp('shred') + '\n')); return 1 }
  let passes = 3, size, remove = false, verbose = false, exact = false, zero = false, force = false
  for (const [key, value] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'version') { writeAll(1, encoder.encode('shred (ecmaOS coreutils) 1.0\n')); return 0 }
    if (key === 'n') {
      if (!/^\d+$/.test(value)) { say(`invalid number of passes: ${quotef(value)}`); return 1 }
      passes = Number(value)
    } else if (key === 's') {
      size = parseSize(value)
      if (size === undefined) { say(`invalid file size: ${quotef(value)}`); return 1 }
    } else if (key === 'u' || key === 'remove') remove = true
    else if (key === 'v') verbose = true
    else if (key === 'x') exact = true
    else if (key === 'z') zero = true
    else if (key === 'f') force = true
  }
  if (operands.length === 0) { say('missing file operand'); writeAll(2, encoder.encode(tryHelp('shred') + '\n')); return 1 }
  let status = 0
  for (const file of operands) {
    let info
    try { info = stat(file) } catch (e) { say(`${file}: failed to open for writing: ${reasonOf(e)}`); status = 1; continue }
    let fd
    try { fd = file === '-' ? 1 : open(file, O_WRONLY) } catch (e) {
      if (force) { try { globalThis.ecmaosSyscalls.chmod(file, (info.mode & 0o7777) | 0o200); fd = open(file, O_WRONLY) } catch { /* below */ } }
      if (fd === undefined) { say(`${file}: failed to open for writing: ${reasonOf(e)}`); status = 1; continue }
    }
    const regular = (info.mode & 0o170000) === 0o100000
    const length = size ?? (regular && !exact ? Math.ceil(info.size / BLOCK) * BLOCK : info.size)
    const total = passes + (zero ? 1 : 0)
    try {
      for (let i = 1; i <= total; i++) {
        const fill = zero && i === total ? 'zero' : 'random'
        if (verbose) say(`${file}: pass ${i}/${total} (${fill === 'zero' ? '000000' : 'random'})...`)
        await pass(fd, length, fill)
      }
    } catch (e) { say(`${file}: error writing at offset: ${reasonOf(e)}`); status = 1 } finally { if (fd !== 1) close(fd) }
    if (!remove || file === '-') continue
    if (verbose) say(`${file}: removing`)
    try {
      await custom('truncate', file, 0)
      // the name goes too, one character at a time, as GNU's wipesync does
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''
      let current = file
      for (let n = file.length - dir.length; n >= 1; n--) {
        const next = dir + '0'.repeat(n)
        try { stat(next); continue } catch { /* free */ }
        rename(current, next)
        if (verbose) say(`${current}: renamed to ${next}`)
        current = next
      }
      unlink(current)
      if (verbose) say(`${file}: removed`)
    } catch (e) { say(`${file}: failed to remove: ${reasonOf(e)}`); status = 1 }
  }
  return status
}

try {
  exit(await main())
} catch (error) {
  say(reasonOf(error))
  exit(1)
}
