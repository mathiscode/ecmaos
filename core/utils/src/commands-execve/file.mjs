/**
 * `file`: say what kind of file something is, as file(1) does. The analysis of the content is in lib/file-magic.mjs;
 * this program has the options, the names, the padding and the special files.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { readFdBytes } from './lib/bytes.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'
import { identify } from './lib/file-magic.mjs'

const { argv, exit, getcwd, lstat, stat, readlink, open, close, read, lseek, O_RDONLY } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const S_IFMT = 0xf000
const HEAD_LIMIT = 1024 * 1024

const USAGE = `Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]
            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]
            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]
            <file> ...
       file -C [-m <magicfiles>]
       file [--help]`

const HELP = `Usage: file [OPTION...] [FILE...]
Determine type of FILEs.

      --help                 display this help and exit
  -v, --version              output version information and exit
  -m, --magic-file LIST      use LIST as a colon-separated list of magic
                               number files
  -z, --uncompress           try to look inside compressed files
  -Z, --uncompress-noreport  only print the contents of compressed files
  -b, --brief                do not prepend filenames to output lines
  -c, --checking-printout    print the parsed form of the magic file, use in
                               conjunction with -m to debug a new magic file
                               before installing it
  -e, --exclude TEST         exclude TEST from the list of test to be
                               performed for file. Valid tests are:
                               apptype, ascii, cdf, compress, csv, elf,
                               encoding, soft, tar, json, simh,
                               text, tokens
      --exclude-quiet TEST   like exclude, but ignore unknown tests
  -f, --files-from FILE      read the filenames to be examined from FILE
  -F, --separator STRING     use string as separator instead of \`:'
  -i, --mime                 output MIME type strings (--mime-type and
                               --mime-encoding)
      --apple                output the Apple CREATOR/TYPE
      --extension            output a slash-separated list of extensions
      --mime-type            output the MIME type
      --mime-encoding        output the MIME encoding
  -k, --keep-going           don't stop at the first match
  -l, --list                 list magic strength
  -L, --dereference          follow symlinks (default if POSIXLY_CORRECT is set)
  -h, --no-dereference       don't follow symlinks (default if POSIXLY_CORRECT is not set) (default)
  -n, --no-buffer            do not buffer output
  -N, --no-pad               do not pad output
  -0, --print0               terminate filenames with ASCII NUL
  -p, --preserve-date        preserve access times on files
  -P, --parameter            set file engine parameter limits
                                   bytes 7340032 max bytes to look inside file
                               elf_notes     256 max ELF notes processed
                               elf_phnum    2048 max ELF prog sections processed
                               elf_shnum   32768 max ELF sections processed
                               elf_shsize 134217728 max ELF section size
                                encoding   65536 max bytes to scan for encoding
                                   indir      50 recursion limit for indirection
                                    name     150 use limit for name/use magic
                                   regex    8192 length limit for REGEX searches
                                 magwarn      64 maximum number of magic warnings
  -r, --raw                  don't translate unprintable chars to \\ooo
  -s, --special-files        treat special (block/char devices) files as
                             ordinary ones
  -S, --no-sandbox           disable system call sandboxing
  -C, --compile              compile file specified by -m
  -d, --debug                print debugging messages

Report bugs to https://bugs.astron.com/`

const out = text => globalThis.ecmaosSyscalls.write(1, encoder.encode(text), -1)
const writeOut = bytes => {
  let at = 0
  while (at < bytes.length) at += globalThis.ecmaosSyscalls.write(1, bytes.subarray(at), -1)
}
const writeErr = text => {
  const bytes = encoder.encode(text)
  let at = 0
  while (at < bytes.length) at += globalThis.ecmaosSyscalls.write(2, bytes.subarray(at), -1)
}
void out

const special = {
  0x4000: ['directory', 'inode/directory'],
  0x1000: ['fifo (named pipe)', 'inode/fifo'],
  0xc000: ['socket', 'inode/socket']
}

function deviceNumbers(info) {
  const rdev = Number(info.rdev ?? 0)
  return `${Math.floor(rdev / 0x100000)}/${rdev % 0x100000}`
}

function readHead(path) {
  const fd = open(path, O_RDONLY, 0)
  try { return readFdBytes(fd, HEAD_LIMIT) } finally { close(fd) }
}

function ioFor(path, size) {
  return {
    size,
    readAt(offset, length) {
      const fd = open(path, O_RDONLY, 0)
      try {
        lseek(fd, offset, 0)
        const buffer = new Uint8Array(length)
        const n = read(fd, buffer, -1)
        return buffer.subarray(0, Math.max(0, n))
      } finally { close(fd) }
    },
    readAll() {
      const fd = open(path, O_RDONLY, 0)
      try { return readFdBytes(fd, 64 * 1024 * 1024) } finally { close(fd) }
    }
  }
}

/** `{ text, mime, encoding }` for a path, or `{ error }` when it cannot be read */
function examine(path, name, o) {
  let info
  try { info = o.follow ? stat(path) : lstat(path) } catch (error) {
    if (o.follow) {
      try {
        lstat(path)
        return { text: `cannot open \`${name}' (No such file or directory)`, mime: 'application/octet-stream', encoding: 'binary', error: true }
      } catch { /* fall through */ }
    }
    return { text: `cannot open \`${name}' (${reasonOf(error)})`, mime: 'application/octet-stream', encoding: 'binary', error: true }
  }
  const type = info.mode & S_IFMT
  const prefix = (info.mode & 0o4000 ? 'setuid ' : '') + (info.mode & 0o2000 ? 'setgid ' : '') + (type !== 0x4000 && info.mode & 0o1000 ? 'sticky ' : '')
  if (type === 0xa000) {
    let target = ''
    try { target = readlink(path) } catch { /* unreadable */ }
    let broken = false
    try { stat(path) } catch { broken = true }
    return { text: `${broken ? 'broken ' : ''}symbolic link to ${target}`, mime: 'inode/symlink', encoding: 'binary' }
  }
  if (type === 0x4000) return { text: `${info.mode & 0o1000 ? 'sticky ' : ''}directory`, mime: 'inode/directory', encoding: 'binary' }
  if ((type === 0x2000 || type === 0x6000) && !o.special) {
    return { text: `${type === 0x2000 ? 'character' : 'block'} special (${deviceNumbers(info)})`, mime: type === 0x2000 ? 'inode/chardevice' : 'inode/blockdevice', encoding: 'binary' }
  }
  if (special[type]) return { text: special[type][0], mime: special[type][1], encoding: 'binary' }
  try {
    const head = readHead(path)
    const result = identify(head, ioFor(path, Number(info.size)))
    return { ...result, text: prefix + result.text }
  } catch (error) {
    return { text: `cannot open \`${name}' (${reasonOf(error)})`, mime: 'application/octet-stream', encoding: 'binary', error: true }
  }
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'bcCdEhiklLnNprsSvzZ0e:f:F:m:P:',
    long: {
      help: 'help', version: 'v', 'magic-file': { key: 'm', arg: 'required' }, uncompress: 'z', 'uncompress-noreport': 'Z', brief: 'b', 'checking-printout': 'c',
      exclude: { key: 'e', arg: 'required' }, 'exclude-quiet': { key: 'e', arg: 'required' }, 'files-from': { key: 'f', arg: 'required' }, separator: { key: 'F', arg: 'required' },
      mime: 'i', apple: 'apple', extension: 'extension', 'mime-type': 'mime-type', 'mime-encoding': 'mime-encoding', 'keep-going': 'k', list: 'l', dereference: 'L',
      'no-dereference': 'h', 'no-buffer': 'n', 'no-pad': 'N', print0: '0', 'preserve-date': 'p', parameter: { key: 'P', arg: 'required' }, raw: 'r', 'special-files': 's',
      'no-sandbox': 'S', compile: 'C', debug: 'd'
    }
  })
  if (error) { writeErr(`file: ${error}\n${USAGE}\n`); return 1 }
  const o = { brief: false, mime: false, mimeType: false, mimeEncoding: false, follow: false, special: false, nopad: false, print0: false, separator: ':', filesFrom: undefined, exitOnError: false }
  for (const [key, value] of options) {
    switch (key) {
      case 'help': writeOut(encoder.encode(HELP + '\n')); return 0
      case 'v': writeOut(encoder.encode('file-5.48\nmagic file from /usr/share/file/misc/magic\n')); return 0
      case 'b': o.brief = true; break
      case 'i': o.mime = true; break
      case 'mime-type': o.mimeType = true; break
      case 'mime-encoding': o.mimeEncoding = true; break
      case 'L': o.follow = true; break
      case 'h': o.follow = false; break
      case 's': o.special = true; break
      case 'N': o.nopad = true; break
      case '0': o.print0 = true; break
      case 'F': o.separator = value; break
      case 'f': o.filesFrom = value; break
      case 'E': o.exitOnError = true; break
      default: break
    }
  }
  if (o.mime) { o.mimeType = true; o.mimeEncoding = true }
  let names = operands
  const cwd = getcwd()
  if (o.filesFrom !== undefined) {
    let text
    try {
      text = new TextDecoder().decode(o.filesFrom === '-' ? readFdBytes(0) : (() => { const fd = open(resolve(cwd, o.filesFrom), O_RDONLY, 0); try { return readFdBytes(fd) } finally { close(fd) } })())
    } catch (e) {
      writeErr(`file: Cannot open \`${o.filesFrom}' (${reasonOf(e)})\n`)
      return 1
    }
    const listed = text.split('\n')
    if (listed[listed.length - 1] === '') listed.pop()
    names = [...listed, ...operands]
  }
  if (names.length === 0) { writeErr(`${USAGE}\n`); return 1 }
  const shown = name => (name === '-' ? '/dev/stdin' : name)
  const width = o.nopad ? 0 : Math.max(...names.map(name => shown(name).length))
  let status = 0
  for (const name of names) {
    let result
    if (name === '-') {
      try {
        const head = readFdBytes(0, HEAD_LIMIT)
        result = identify(head, { size: head.length, readAt: () => new Uint8Array(0), readAll: () => head })
      } catch (e) { result = { text: `cannot open \`/dev/stdin' (${reasonOf(e)})`, mime: 'application/octet-stream', encoding: 'binary', error: true } }
    } else result = examine(resolve(cwd, name), name, o)
    if (result.error && o.exitOnError) status = 1
    let description
    if (result.error || !(o.mimeType || o.mimeEncoding)) description = result.text
    else if (o.mimeType && o.mimeEncoding) description = `${result.mime}; charset=${result.encoding}`
    else description = o.mimeType ? result.mime : result.encoding
    if (o.brief) { writeOut(encoder.encode(`${description}\n`)); continue }
    const label = shown(name)
    const head = o.print0 ? `${label}\0${o.separator}` : `${label}${o.separator}`
    const pad = o.nopad ? ' ' : ' '.repeat(Math.max(1, width - label.length + 1))
    writeOut(encoder.encode(`${head}${pad}${description}\n`))
  }
  return status
}

try {
  exit(main())
} catch (error) {
  writeErr(`file: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
}
void tryHelp
