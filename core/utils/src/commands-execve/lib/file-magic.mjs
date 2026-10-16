/**
 * What `file` says about a file's content: the text analysis of libmagic (encoding, line terminators, long lines, escape
 * sequences), the scripts it knows by their first line, the programming and markup languages it recognises by their
 * look, and the headers of the common binary formats (executables, archives, images, documents).
 *
 * `identify(head, io)` takes the first bytes of the file and `io = { size, readAt(offset, length), readAll() }` for the
 * formats whose description needs bytes from elsewhere in the file. It returns `{ text, mime, encoding }`.
 */

const latin1 = (bytes, from = 0, to = bytes.length) => {
  let out = ''
  for (let i = from; i < to && i < bytes.length; i += 4096) out += String.fromCharCode(...bytes.subarray(i, Math.min(to, i + 4096, bytes.length)))
  return out
}
const u16 = (b, o, le = true) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1])
const u32 = (b, o, le = true) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0)
const u64 = (b, o, le = true) => Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, le))
const hex = (b, from, to) => Array.from(b.subarray(from, to), x => x.toString(16).padStart(2, '0')).join('')
const startsWith = (b, s, at = 0) => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** `ctime(3)` without the newline, from a Date read in UTC */
const ctimeUtc = ms => {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

const binary = (text, mime) => ({ text, mime, encoding: 'binary' })

// ---------------------------------------------------------------------------------------------------------------- ELF

const ELF_TYPES = { 1: 'relocatable', 2: 'executable', 3: 'shared object', 4: 'core file' }
const ELF_MACHINES = {
  0x03: 'Intel 80386', 0x08: 'MIPS', 0x14: 'PowerPC', 0x15: 'PowerPC64', 0x16: 'IBM S/390', 0x28: 'ARM', 0x2a: 'Renesas SH', 0x32: 'Intel IA-64',
  0x3e: 'x86-64', 0xb7: 'ARM aarch64', 0xf3: 'UCB RISC-V', 0xf7: 'Linux BPF', 0x102: 'LoongArch', 0x06: 'Intel 80486', 0x02: 'SPARC', 0x2b: 'SPARC V9', 0x5e: 'Xtensa'
}
const ELF_OS = { 0: 'SYSV', 1: 'HP-UX', 2: 'NetBSD', 3: 'GNU/Linux', 6: 'Solaris', 9: 'FreeBSD', 12: 'OpenBSD' }

function describeElf(b, io) {
  const full = io.size > b.length && io.size <= 64 * 1024 * 1024 ? io.readAll() : b
  const x = full
  const is64 = x[4] === 2
  const le = x[5] !== 2
  if (x[4] !== 1 && x[4] !== 2) return undefined
  const rd16 = o => u16(x, o, le)
  const rd32 = o => u32(x, o, le)
  const rdN = o => (is64 ? u64(x, o, le) : rd32(o))
  const type = rd16(16)
  const machine = rd16(18)
  const phoff = is64 ? u64(x, 32, le) : rd32(28)
  const shoff = is64 ? u64(x, 40, le) : rd32(32)
  const phentsize = rd16(is64 ? 54 : 42)
  const phnum = rd16(is64 ? 56 : 44)
  const shentsize = rd16(is64 ? 58 : 46)
  const shnum = rd16(is64 ? 60 : 48)
  const shstrndx = rd16(is64 ? 62 : 50)
  const osabi = x[7]
  let interpreter
  let dynamic = false
  let pieFlag = false
  const notes = []
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize
    if (at + phentsize > x.length) break
    const ptype = rd32(at)
    const offset = is64 ? u64(x, at + 8, le) : rd32(at + 4)
    const filesz = is64 ? u64(x, at + 32, le) : rd32(at + 16)
    if (ptype === 3 && offset + filesz <= x.length) interpreter = latin1(x, offset, offset + filesz).replace(/\0.*$/s, '')
    else if (ptype === 2) dynamic = true
    else if (ptype === 4 && offset + filesz <= x.length) {
      let p = offset
      while (p + 12 <= offset + filesz) {
        const namesz = rd32(p)
        const descsz = rd32(p + 4)
        const ntype = rd32(p + 8)
        const name = latin1(x, p + 12, p + 12 + namesz).replace(/\0.*$/s, '')
        const desc = p + 12 + ((namesz + 3) & ~3)
        notes.push({ name, ntype, desc, descsz })
        p = desc + ((descsz + 3) & ~3)
      }
    }
  }
  // sections: a symbol table means it is not stripped; .debug_info means debugging information
  let stripped = true
  let debugInfo = false
  if (shoff && shnum && shentsize && shoff + shnum * shentsize <= x.length) {
    const strAt = shoff + shstrndx * shentsize
    const strOff = is64 ? u64(x, strAt + 24, le) : rd32(strAt + 16)
    for (let i = 0; i < shnum; i++) {
      const at = shoff + i * shentsize
      const stype = rd32(at + 4)
      if (stype === 2) stripped = false
      const nameAt = strOff + rd32(at)
      if (nameAt < x.length && latin1(x, nameAt, nameAt + 12).startsWith('.debug_info\0')) debugInfo = true
      if (stype === 6) {
        const off = is64 ? u64(x, at + 24, le) : rd32(at + 16)
        const size = is64 ? u64(x, at + 32, le) : rd32(at + 20)
        for (let p = off; p + (is64 ? 16 : 8) <= off + size && p + 16 <= x.length; p += is64 ? 16 : 8) {
          const tag = rdN(p)
          const val = rdN(p + (is64 ? 8 : 4))
          if (tag === 0x6ffffffb && (val & 0x08000000)) pieFlag = true
        }
      }
    }
  }
  const parts = [`ELF ${is64 ? '64' : '32'}-bit ${le ? 'LSB' : 'MSB'}`]
  let kind = ELF_TYPES[type] ?? `type ${type}`
  if (type === 3 && (interpreter !== undefined || pieFlag)) kind = pieFlag && interpreter === undefined && dynamic ? 'pie executable' : 'pie executable'
  if (type === 3 && interpreter === undefined && !pieFlag) kind = 'shared object'
  parts[0] += ` ${kind}`
  parts.push(ELF_MACHINES[machine] ?? `*unknown arch 0x${machine.toString(16)}*`)
  parts.push(`version ${x[6]} (${ELF_OS[osabi] ?? osabi})`)
  if (type !== 1 && type !== 4) {
    if (interpreter !== undefined || dynamic) parts.push(type === 3 && interpreter === undefined && !pieFlag ? 'dynamically linked' : interpreter === undefined && type === 3 ? 'static-pie linked' : 'dynamically linked')
    else parts.push('statically linked')
    if (interpreter !== undefined) parts.push(`interpreter ${interpreter}`)
  }
  for (const note of notes) {
    if (note.name === 'GNU' && note.ntype === 3) parts.push(`BuildID[${note.descsz === 20 ? 'sha1' : note.descsz === 16 ? 'md5/uuid' : 'xxHash'}]=${hex(x, note.desc, note.desc + note.descsz)}`)
    else if (note.name === 'GNU' && note.ntype === 1 && note.descsz >= 16) {
      const os = rd32(note.desc)
      parts.push(`for ${os === 0 ? 'GNU/Linux' : os === 1 ? 'GNU/Hurd' : os === 2 ? 'Solaris' : 'GNU'} ${rd32(note.desc + 4)}.${rd32(note.desc + 8)}.${rd32(note.desc + 12)}`)
    }
  }
  if (debugInfo) parts.push('with debug_info')
  if (type === 4) return binary(parts.join(', '), 'application/x-coredump')
  parts.push(stripped ? 'stripped' : 'not stripped')
  const mime = type === 1 ? 'application/x-object' : type === 3 && interpreter === undefined && !pieFlag ? 'application/x-sharedlib' : type === 3 ? 'application/x-pie-executable' : 'application/x-executable'
  return binary(parts.join(', '), mime)
}

// ----------------------------------------------------------------------------------------------------------- archives

function describeGzip(b, io) {
  const flags = b[3]
  const mtime = u32(b, 4)
  const xfl = b[8]
  const os = b[9]
  const OS = { 0: 'FAT filesystem', 1: 'Amiga', 2: 'VMS', 3: 'Unix', 4: 'VM/CMS', 5: 'Atari', 6: 'HPFS filesystem', 7: 'Macintosh', 8: 'Z-System', 9: 'CP/M', 10: 'TOPS-20', 11: 'NTFS filesystem', 12: 'QDOS', 13: 'Acorn RISCOS' }
  const parts = ['gzip compressed data']
  let at = 10
  if (flags & 4) { const n = u16(b, at); parts.push('has extra field'); at += 2 + n }
  if (flags & 8) { let end = b.indexOf(0, at); if (end < 0) end = b.length; parts.push(`was "${latin1(b, at, end)}"`); at = end + 1 }
  if (flags & 16) { let end = b.indexOf(0, at); if (end < 0) end = b.length; parts.push(`has comment "${latin1(b, at, end)}"`); at = end + 1 }
  if (flags & 2) parts.push('has header CRC')
  if (mtime) parts.push(`last modified: ${ctimeUtc(mtime * 1000)}`)
  if (xfl === 2) parts.push('max compression')
  else if (xfl === 4) parts.push('max speed')
  parts.push(`from ${OS[os] ?? 'unknown'}`)
  if (io.size >= 18) {
    const tail = io.readAt(io.size - 4, 4)
    if (tail.length === 4) parts.push(`original size modulo 2^32 ${u32(tail, 0)}`)
  }
  return binary(parts.join(', '), 'application/gzip')
}

const ZIP_HOSTS = ['MS-DOS', 'Amiga', 'OpenVMS', 'UNIX', 'VM/CMS', 'Atari ST', 'OS/2', 'MacOS', 'Z-System', 'CP/M', 'TOPS-20', 'Win32', 'SMS/QDOS', 'Acorn RISC OS', 'Win32 VFAT', 'MVS', 'BeOS', 'Tandem', 'OS/400', 'OS X']
const ZIP_METHODS = { 0: 'store', 1: 'shrink', 6: 'implode', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz', 98: 'ppmd' }

function describeZip(b, io) {
  // the first entry's central directory record carries the "made by" host
  let made
  let centralSize
  if (io.size >= 22) {
    const lookback = Math.min(io.size, 65557)
    const tail = io.readAt(io.size - lookback, lookback)
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
        const offset = u32(tail, i + 16)
        const head = io.readAt(offset, 46)
        if (head.length === 46 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 1 && head[3] === 2) { made = head; centralSize = true }
        break
      }
    }
  }
  const version = v => `${Math.floor(v / 10)}.${v % 10}`
  const method = u16(b, 8)
  const time = u16(b, 10)
  const date = u16(b, 12)
  const usize = u32(b, 22)
  const modified = `${MONTHS[((date >> 5) & 15) - 1] ?? '???'} ${(date & 31)} ${1980 + (date >> 9)} ${String((time >> 11) & 31).padStart(2, '0')}:${String((time >> 5) & 63).padStart(2, '0')}:${String((time & 31) * 2).padStart(2, '0')}`
  const parts = ['Zip archive data']
  if (centralSize && made) parts.push(`made by v${version(made[4])} ${ZIP_HOSTS[made[5]] ?? 'unknown'}`)
  parts.push(centralSize ? `extract using at least v${version(u16(b, 4))}` : `at least v${version(u16(b, 4))} to extract`)
  if (centralSize) parts.push(`last modified ${modified}`)
  if (centralSize) parts.push(`uncompressed size ${usize}`)
  parts.push(`${centralSize ? 'method' : 'compression method'}=${ZIP_METHODS[method] ?? method}`)
  return binary(parts.join(', '), 'application/zip')
}

function describeTar(b) {
  // a header is a tar header when its checksum matches
  if (b.length < 512) return undefined
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i]
  const field = latin1(b, 148, 156).replace(/\0.*$/s, '').trim()
  if (!/^[0-7]+$/.test(field) || parseInt(field, 8) !== sum) return undefined
  if (startsWith(b, 'ustar\0', 257) && b[263] === 0x30 && b[264] === 0x30) return binary('POSIX tar archive', 'application/x-tar')
  if (startsWith(b, 'ustar  \0', 257)) return binary('POSIX tar archive (GNU)', 'application/x-tar')
  return binary('tar archive', 'application/x-tar')
}

// -------------------------------------------------------------------------------------------------------------- images

const PNG_COLOR = { 0: 'grayscale', 2: 'RGB', 3: 'colormap', 4: 'gray+alpha', 6: 'RGBA' }

function describePng(b) {
  if (b.length < 24 || latin1(b, 12, 16) !== 'IHDR') return binary('PNG image data', 'image/png')
  const depth = b[24] ?? 0
  const color = b[25] ?? 0
  const label = color === 2 || color === 6 ? `${depth}-bit/color ${PNG_COLOR[color]}` : `${depth}-bit ${PNG_COLOR[color] ?? color}`
  return binary(`PNG image data, ${u32(b, 16, false)} x ${u32(b, 20, false)}, ${label}, ${b[28] ? 'interlaced' : 'non-interlaced'}`, 'image/png')
}

function describeGif(b) {
  return binary(`GIF image data, version ${latin1(b, 3, 6)}, ${u16(b, 6)} x ${u16(b, 8)}`, 'image/gif')
}

function describeJpeg(b) {
  const parts = ['JPEG image data']
  let at = 2
  let jfif = false
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) break
    const marker = b[at + 1]
    const length = u16(b, at + 2, false)
    if (marker === 0xe0 && latin1(b, at + 4, at + 9) === 'JFIF\0') {
      jfif = true
      const units = b[at + 11]
      parts.push(`JFIF standard ${b[at + 9]}.${String(b[at + 10]).padStart(2, '0')}`)
      parts.push(units === 1 ? 'resolution (DPI)' : units === 2 ? 'resolution (DPCM)' : 'aspect ratio')
      parts.push(`density ${u16(b, at + 12, false)}x${u16(b, at + 14, false)}`)
      parts.push(`segment length ${length}`)
    } else if (marker === 0xe1 && latin1(b, at + 4, at + 8) === 'Exif') {
      parts.push('Exif Standard')
    } else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      parts.push(marker === 0xc0 ? 'baseline' : marker === 0xc2 ? 'progressive' : `type ${marker.toString(16)}`)
      parts.push(`precision ${b[at + 4]}`)
      parts.push(`${u16(b, at + 7, false)}x${u16(b, at + 5, false)}`)
      parts.push(`components ${b[at + 9]}`)
      break
    }
    at += 2 + length
  }
  void jfif
  return binary(parts.join(', '), 'image/jpeg')
}

function describeBmp(b) {
  if (b.length < 26) return undefined
  const size = u32(b, 14)
  if (size === 12) return binary(`PC bitmap, OS/2, ${u16(b, 18)} x ${u16(b, 20)} x ${u16(b, 24)}`, 'image/bmp')
  const width = u32(b, 18)
  const height = u32(b, 22)
  const bits = u16(b, 28)
  const sizes = { 40: 'Windows 3.x format', 108: 'Windows 98/2000 and newer format', 124: 'Windows 98/2000 and newer format' }
  if (!sizes[size]) return undefined
  return binary(`PC bitmap, ${sizes[size]}, ${width} x ${height} x ${bits}, image size ${u32(b, 34)}, resolution ${u32(b, 38)} x ${u32(b, 42)} px/m, cbSize ${u32(b, 2)}, bits offset ${u32(b, 10)}`, 'image/bmp')
}

// ------------------------------------------------------------------------------------------------------ other binaries

function describeSqlite(b) {
  if (b.length < 100) return binary('SQLite 3.x database', 'application/vnd.sqlite3')
  const enc = { 1: 'UTF-8', 2: 'UTF-16 little-endian', 3: 'UTF-16 big-endian' }[u32(b, 56, false)]
  const parts = ['SQLite 3.x database', `last written using SQLite version ${u32(b, 96, false)}`, `file counter ${u32(b, 24, false)}`, `database pages ${u32(b, 28, false)}`, `cookie 0x${u32(b, 40, false).toString(16)}`, `schema ${u32(b, 44, false)}`, `largest root page ${u32(b, 52, false)}`]
  if (enc) parts.push(enc)
  parts.push(`version-valid-for ${u32(b, 92, false)}`)
  return binary(parts.join(', '), 'application/vnd.sqlite3')
}

function describeClass(b) {
  const major = u16(b, 6, false)
  const minor = u16(b, 4, false)
  const java = major >= 49 ? ` (Java ${major - 44})` : major === 48 ? ' (Java 1.4)' : major === 47 ? ' (Java 1.3)' : major === 46 ? ' (Java 1.2)' : ''
  return binary(`compiled Java class data, version ${major}.${minor}${java}`, 'application/x-java-applet')
}

function describeWasm(b) {
  const version = u32(b, 4)
  return binary(`WebAssembly (wasm) binary version 0x${version.toString(16)}${version === 1 ? ' (MVP module)' : ''}`, 'application/octet-stream')
}

const WAV_FORMATS = { 1: 'Microsoft PCM', 3: 'IEEE float', 6: 'ITU G.711 A-law', 7: 'ITU G.711 mu-law', 17: 'IMA ADPCM', 85: 'MPEG Layer 3' }
function describeRiff(b) {
  const kind = latin1(b, 8, 12)
  if (kind === 'WAVE' && b.length >= 36 && latin1(b, 12, 16) === 'fmt ') {
    const format = u16(b, 20)
    const channels = u16(b, 22)
    const rate = u32(b, 24)
    const bits = u16(b, 34)
    return binary(`RIFF (little-endian) data, WAVE audio, ${WAV_FORMATS[format] ?? `format ${format}`}, ${bits} bit, ${channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`} ${rate} Hz`, 'audio/x-wav')
  }
  if (kind === 'WEBP') return binary('RIFF (little-endian) data, Web/P image', 'image/webp')
  if (kind === 'AVI ') return binary('RIFF (little-endian) data, AVI', 'video/x-msvideo')
  return binary('RIFF (little-endian) data', 'application/octet-stream')
}

const PYC_VERSIONS = [[3379, '3.6'], [3394, '3.7'], [3413, '3.8'], [3425, '3.9'], [3439, '3.10'], [3495, '3.11'], [3531, '3.12'], [3571, '3.13'], [3627, '3.14'], [3699, '3.15']]
function describePyc(b) {
  const magic = u16(b, 0)
  const version = PYC_VERSIONS.find(([top]) => magic <= top && magic >= top - 60)
  if (!version || b[2] !== 0x0d || b[3] !== 0x0a || b.length < 16) return undefined
  const flags = u32(b, 4)
  const parts = [`Byte-compiled Python module for CPython ${version[1]} (magic: ${magic})`]
  if (flags & 1) parts.push('hash-based', `check-source flag ${flags & 2 ? '' : 'not '}set`, `hash: 0x${u64Hex(b, 8).replace(/^0+(?=.)/, '')}`)
  else parts.push('timestamp-based', `.py timestamp: ${ctimeUtc(u32(b, 8) * 1000)} UTC`, `.py size: ${u32(b, 12)} bytes`)
  return binary(parts.join(', '), 'application/x-bytecode.python')
}
const u64Hex = (b, o) => Array.from(b.subarray(o, o + 8)).reverse().map(x => x.toString(16).padStart(2, '0')).join('')

/** `wOFF` and `wOF2`: web fonts; the flavor says what the font inside is */
function describeWoff(b, two) {
  const flavor = u32(b, 4, false)
  const kind = flavor === 0x00010000 ? 'TrueType' : flavor === 0x4f54544f ? 'CFF' : flavor === 0x74727565 ? 'TrueType' : undefined
  const at = two ? 24 : 20
  const version = `${u16(b, at, false)}.${u16(b, at + 2, false)}`
  const name = two ? 'Web Open Font Format (Version 2)' : 'Web Open Font Format'
  return binary(`${name}${kind ? `, ${kind}` : ''}, length ${u32(b, 8, false)}, version ${version}`, two ? 'font/woff2' : 'font/woff')
}

/** A compiled terminfo entry: the first of its names */
function describeTerminfo(b, wide) {
  const size = u16(b, 2)
  const names = latin1(b, 12, Math.min(b.length, 12 + size)).split('\0')[0].split('|')[0]
  return binary(`Compiled ${wide ? '32-bit ' : ''}terminfo entry "${names}"`, wide ? 'application/x-terminfo2' : 'application/x-terminfo')
}

/** `TZif`: a time zone file; slim files keep a token first block, fat ones keep the whole table in both */
function describeTzif(b) {
  const plural = (n, one, many) => (n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`)
  const version = b[4] === 0 ? 0 : b[4] - 0x30
  const counts = at => ({ isut: u32(b, at + 20, false), isstd: u32(b, at + 24, false), leap: u32(b, at + 28, false), time: u32(b, at + 32, false), type: u32(b, at + 36, false), chars: u32(b, at + 40, false) })
  const first = counts(0)
  let c = first
  let fat = true
  if (version >= 2) {
    const dataEnd = 44 + first.time * 4 + first.time + first.type * 6 + first.chars + first.leap * 8 + first.isstd + first.isut
    if (b.length >= dataEnd + 44 && startsWith(b, 'TZif', dataEnd)) { c = counts(dataEnd); fat = first.time > 0 || first.chars > 1 || first.type > 1 }
  }
  const parts = [`timezone data${version >= 2 ? ` (${fat ? 'fat' : 'slim'})` : ', old version'}`]
  if (version >= 2) parts.push(`version ${version}`)
  parts.push(plural(c.isut, 'gmt time flag', 'gmt time flags'), plural(c.isstd, 'std time flag', 'std time flags'), plural(c.leap, 'leap second', 'leap seconds'),
    plural(c.time, 'transition time', 'transition times'), plural(c.type, 'local time type', 'local time types'), plural(c.chars, 'abbreviation char', 'abbreviation chars'))
  return binary(parts.join(', '), 'application/octet-stream')
}

function binarySignature(b, io) {
  const n = b.length
  if (n >= 52 && b[0] === 0x7f && startsWith(b, 'ELF', 1)) return describeElf(b, io)
  if (n >= 10 && b[0] === 0x1f && b[1] === 0x8b) return describeGzip(b, io)
  if (n >= 30 && startsWith(b, 'PK\x03\x04')) return describeZip(b, io)
  if (n >= 22 && startsWith(b, 'PK\x05\x06')) return binary('Zip archive data (empty)', 'application/zip')
  if (n >= 4 && startsWith(b, 'BZh') && b[3] >= 0x31 && b[3] <= 0x39) return binary(`bzip2 compressed data, block size = ${b[3] - 0x30}00k`, 'application/x-bzip2')
  if (n >= 8 && b[0] === 0xfd && startsWith(b, '7zXZ\0', 1)) {
    const check = { 0: 'None', 1: 'CRC32', 4: 'CRC64', 10: 'SHA-256' }[b[7]] ?? `check ${b[7]}`
    return binary(`XZ compressed data, checksum ${check}`, 'application/x-xz')
  }
  if (n >= 5 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) {
    const dict = b[4] & 3
    return binary(`Zstandard compressed data (v0.8+), Dictionary ID: ${dict === 0 ? 'None' : 'Present'}`, 'application/zstd')
  }
  if (n >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) return binary(`7-zip archive data, version ${b[6]}.${b[7]}`, 'application/x-7z-compressed')
  if (n >= 7 && startsWith(b, 'Rar!\x1a\x07')) return binary(`RAR archive data, ${b[6] === 0 ? 'v4' : 'v5'}`, 'application/x-rar')
  if (n >= 8 && startsWith(b, '!<arch>\n')) return binary('current ar archive', 'application/x-archive')
  if (n >= 8 && b[0] === 0x89 && startsWith(b, 'PNG\r\n\x1a\n', 1)) return describePng(b)
  if (n >= 10 && (startsWith(b, 'GIF87a') || startsWith(b, 'GIF89a'))) return describeGif(b)
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return describeJpeg(b)
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) { const bmp = describeBmp(b); if (bmp) return bmp }
  if (n >= 12 && startsWith(b, 'RIFF')) return describeRiff(b)
  if (n >= 8 && b[0] === 0 && startsWith(b, 'asm', 1)) return describeWasm(b)
  if (n >= 16 && startsWith(b, 'SQLite format 3\0')) return describeSqlite(b)
  if (n >= 48 && startsWith(b, 'wOFF')) return describeWoff(b, false)
  if (n >= 48 && startsWith(b, 'wOF2')) return describeWoff(b, true)
  if (n >= 12 && startsWith(b, 'OTTO')) return binary('OpenType font data', 'application/vnd.ms-opentype')
  if (n >= 44 && startsWith(b, 'TZif')) return describeTzif(b)
  if (n >= 12 && ((b[0] === 0x1a && b[1] === 0x01) || (b[0] === 0x1e && b[1] === 0x02)) && u16(b, 2) > 0 && u16(b, 2) < 4096 && b[12] >= 0x20 && b[12] < 0x7f) return describeTerminfo(b, b[0] === 0x1e)
  if (n >= 8 && b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe && u16(b, 6, false) >= 45 && u16(b, 6, false) < 100) return describeClass(b)
  if (n >= 4 && startsWith(b, 'OggS')) return binary('Ogg data, Vorbis audio', 'audio/ogg')
  if (n >= 4 && startsWith(b, 'fLaC')) return binary('FLAC audio bitstream data', 'audio/flac')
  if (n >= 3 && startsWith(b, 'ID3')) return binary(`Audio file with ID3 version 2.${b[3]}.${b[4]}`, 'audio/mpeg')
  if (n >= 5 && startsWith(b, '%PDF-')) return binary(`PDF document, version ${latin1(b, 5, 8).replace(/[^0-9.]/g, '')}`, 'application/pdf')
  if (n >= 16 && b[2] === 0x0d && b[3] === 0x0a) { const pyc = describePyc(b); if (pyc) return pyc }
  if (n >= 512) { const tar = describeTar(b); if (tar) return tar }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------- text

/** The bytes as text: which encoding, and what is in it; `undefined` when they are data */
function analyseText(b) {
  const n = b.length
  let bom
  let start = 0
  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { bom = 'utf8'; start = 3 }
  if (n >= 2 && b[0] === 0xff && b[1] === 0xfe) bom = n >= 4 && b[2] === 0 && b[3] === 0 ? 'utf32le' : 'utf16le'
  if (n >= 2 && b[0] === 0xfe && b[1] === 0xff) bom = 'utf16be'
  if (n >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) bom = 'utf32be'
  if (bom === 'utf16le' || bom === 'utf16be' || bom === 'utf32le' || bom === 'utf32be') {
    const width = bom.startsWith('utf32') ? 4 : 2
    const le = bom.endsWith('le')
    const chars = []
    for (let i = width; i + width <= n; i += width) chars.push(width === 2 ? u16(b, i, le) : u32(b, i, le))
    if (chars.some(c => c > 0x10ffff || (c < 32 && ![9, 10, 12, 13, 27, 8, 7, 11].includes(c)) || (c >= 0xd800 && c < 0xe000))) return undefined
    const text = String.fromCodePoint(...chars)
    return { kind: bom, text, encoding: bom.slice(0, -2) === 'utf16' ? `utf-16${le ? 'le' : 'be'}` : `utf-32${le ? 'le' : 'be'}`, bytes: b }
  }
  let ascii = true
  let high = false
  let iso = true
  let control = false
  for (let i = start; i < n; i++) {
    const c = b[i]
    if (c < 32) {
      if (!(c >= 7 && c <= 13) && c !== 27) { control = true; break }
    } else if (c === 127) { control = true; break } else if (c >= 128) {
      ascii = false
      high = true
      if (c < 160) iso = false
    }
  }
  if (control) return undefined
  if (ascii && bom === 'utf8') return { kind: 'utf8bom', text: latin1(b, 3), encoding: 'utf-8', bytes: b }
  if (ascii) return { kind: 'ascii', text: latin1(b), encoding: 'us-ascii', bytes: b }
  void high
  // UTF-8: valid sequences only
  let utf8 = true
  for (let i = start; i < n;) {
    const c = b[i]
    if (c < 0x80) { i++; continue }
    const len = c >= 0xf0 && c < 0xf8 ? 4 : c >= 0xe0 ? 3 : c >= 0xc2 && c < 0xe0 ? 2 : 0
    if (!len || c >= 0xf8 || i + len > n) { utf8 = false; break }
    for (let k = 1; k < len; k++) if ((b[i + k] & 0xc0) !== 0x80) { utf8 = false; break }
    if (!utf8) break
    i += len
  }
  if (utf8) {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(start)) } catch { utf8 = false }
    if (utf8) return { kind: bom === 'utf8' ? 'utf8bom' : 'utf8', text, encoding: 'utf-8', bytes: b }
  }
  return iso ? { kind: 'iso', text: latin1(b), encoding: 'iso-8859-1', bytes: b } : { kind: 'ext', text: latin1(b), encoding: 'unknown-8bit', bytes: b }
}

const ENCODING_TEXT = {
  ascii: 'ASCII text', utf8: 'Unicode text, UTF-8 text', utf8bom: 'Unicode text, UTF-8 (with BOM) text', iso: 'ISO-8859 text', ext: 'Non-ISO extended-ASCII text',
  utf16le: 'Unicode text, UTF-16, little-endian text', utf16be: 'Unicode text, UTF-16, big-endian text',
  utf32le: 'Unicode text, UTF-32, little-endian text', utf32be: 'Unicode text, UTF-32, big-endian text'
}

/** ", with very long lines (N)", the line terminators, escape sequences and overstriking */
function textAttributes(analysis) {
  const { text, kind } = analysis
  let longest = 0
  let crlf = 0
  let cr = 0
  let lf = 0
  let current = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf++; i++ } else cr++
      longest = Math.max(longest, current)
      current = 0
    } else if (c === 10) { lf++; longest = Math.max(longest, current); current = 0 } else current++
  }
  longest = Math.max(longest, current)
  let out = ''
  if (longest > 300) out += `, with very long lines (${longest})`
  if (crlf + cr + lf === 0) out += ', with no line terminators'
  else if (crlf || cr) out += `, with ${[crlf && 'CRLF', cr && 'CR', lf && 'LF'].filter(Boolean).join(', ')} line terminators`
  if (kind !== 'utf16le' && kind !== 'utf16be' && text.includes('\x1b')) out += ', with escape sequences'
  if (text.includes('\b')) out += ', with overstriking'
  return out
}

const SHELLS = {
  sh: 'POSIX shell script', bash: 'Bourne-Again shell script', dash: 'Dash shell script', ksh: 'Korn shell script', ksh93: 'Korn shell script', zsh: "Paul Falstad's zsh script",
  csh: 'C shell script', tcsh: 'Tenex C shell script', fish: 'fish shell script', ash: 'Ash shell script', ecmash: 'Bourne-Again shell script'
}
const SCRIPTS = {
  perl: 'Perl script text executable', ruby: 'Ruby script', lua: 'Lua script', awk: 'awk script', gawk: 'GNU awk script', mawk: 'mawk script', nawk: 'nawk script',
  php: 'PHP script', tclsh: 'Tcl/Tk script', wish: 'Tcl/Tk script', make: 'makefile script', expect: 'Tcl/Tk script', python: 'Python script', 'node': 'Node.js script executable', nodejs: 'Node.js script executable'
}
const SCRIPT_MIME = {
  'POSIX shell script': 'text/x-shellscript', 'Bourne-Again shell script': 'text/x-shellscript', 'Dash shell script': 'text/x-shellscript', 'Korn shell script': 'text/x-shellscript',
  "Paul Falstad's zsh script": 'text/x-shellscript', 'C shell script': 'text/x-shellscript', 'Tenex C shell script': 'text/x-shellscript', 'fish shell script': 'text/x-shellscript',
  'Perl script text executable': 'text/x-perl', 'Ruby script': 'text/x-ruby', 'Lua script': 'text/x-lua', 'awk script': 'text/x-awk', 'GNU awk script': 'text/x-gawk', 'mawk script': 'text/x-awk',
  'nawk script': 'text/x-awk', 'PHP script': 'text/x-php', 'Tcl/Tk script': 'text/x-tcl', 'makefile script': 'text/x-makefile', 'Python script': 'text/x-script.python',
  'Node.js script executable': 'text/javascript'
}

/** The description of a script from its `#!` line, or `undefined` */
function shebang(text) {
  if (!text.startsWith('#!')) return undefined
  const line = text.slice(2, text.indexOf('\n') < 0 ? undefined : text.indexOf('\n')).replace(/\r$/, '').trim()
  if (line === '') return undefined
  if (!text.includes('\n')) return { name: `a ${line.split(/\s+/)[0]} script`, interpreter: line.split(/\s+/)[0], generic: true }
  const words = line.split(/\s+/)
  let program = words[0]
  let rest = words.slice(1)
  let base = program.split('/').pop()
  if (base === 'env') {
    // env [-S] [VAR=value...] program [arguments]
    let i = 0
    while (i < rest.length && (rest[i].startsWith('-') && rest[i] !== '-S' ? true : rest[i] === '-S' ? true : rest[i].includes('='))) i++
    if (rest.some(w => w === '-S') && rest.length > 1) {
      const name = rest.slice(rest.indexOf('-S') + 1)
      if (name.length > 1 || (name[0] && !SHELLS[name[0]] && !SCRIPTS[name[0]] && !/^python/.test(name[0]))) return { name: `a ${name.join(' ')} script`, interpreter: name[0] }
    }
    program = rest[i] ?? 'env'
    rest = rest.slice(i + 1)
    base = program.split('/').pop()
  }
  const key = base.replace(/\d+(\.\d+)*$/, '') || base
  if (SHELLS[base]) return { name: SHELLS[base], interpreter: base }
  if (/^python[\d.]*$/.test(base)) return { name: 'Python script', interpreter: 'python' }
  if (/^(gawk|mawk|nawk|awk)$/.test(key)) return { name: SCRIPTS[key], interpreter: key }
  if (SCRIPTS[key]) return { name: SCRIPTS[key], interpreter: key }
  if (SCRIPTS[base]) return { name: SCRIPTS[base], interpreter: base }
  void rest
  return { name: `a ${program === words[0] && base !== 'env' ? words[0] : program} script`, interpreter: base }
}

function looksLikeJson(text) {
  const t = text.trim()
  if (!/^[[{]/.test(t)) return false
  try { JSON.parse(t); return true } catch { return false }
}

/** A language or markup recognised in the text: `{ name, mime }` or `undefined` */
function recognise(text) {
  const head = text.slice(0, 65536)
  const trimmed = head.trimStart()
  if (/^<\?xml\s+version="1\.(\d)"/i.test(trimmed)) {
    const version = /^<\?xml\s+version="1\.(\d)"/i.exec(trimmed)[1]
    if (/<svg[\s>]/.test(head)) return { name: 'SVG Scalable Vector Graphics image', mime: 'image/svg+xml', bare: true }
    return { name: `XML 1.${version} document`, mime: 'text/xml' }
  }
  if (/^<svg[\s>]/.test(trimmed) || (/^<!DOCTYPE svg/i.test(trimmed))) return { name: 'SVG Scalable Vector Graphics image', mime: 'image/svg+xml', bare: true }
  if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /<html[\s>]/i.test(head) || /^<(head|body|title)[\s>]/i.test(trimmed) || /<a\s+href=/i.test(head)) return { name: 'HTML document', mime: 'text/html' }
  if (/^<\?php/.test(trimmed)) return { name: 'PHP script', mime: 'text/x-php' }
  if (/^<!--/.test(trimmed)) return { name: 'exported SGML document', mime: 'text/sgml' }
  if (/^%!PS-Adobe-(\d+\.\d+)/.test(head)) return { name: `PostScript document text conforming DSC level ${/^%!PS-Adobe-(\d+\.\d+)/.exec(head)[1]}`, mime: 'application/postscript', bare: true }
  if (/^\{\\rtf(\d)/.test(head)) return { name: `Rich Text Format data, version ${/^\{\\rtf(\d)/.exec(head)[1]}, ANSI`, mime: 'text/rtf', bare: true }
  if (looksLikeJson(head)) return { name: 'JSON text data', mime: 'application/json', bare: true }
  const firstLine = head.slice(0, head.indexOf('\n') < 0 ? undefined : head.indexOf('\n'))
  if (/^diff --git /.test(head)) {
    const lines = head.split('\n')
    return { name: `unified diff output text, 1st line "${lines[0]}", 2nd line "${lines[1] ?? ''}", 3rd line "${lines[2] ?? ''}"`, mime: 'text/x-diff' }
  }
  if (/^--- .*\n\+\+\+ .*\n@@ /.test(head)) return { name: 'unified diff output', mime: 'text/x-diff' }
  if (/^(Return-Path|Received): /.test(firstLine)) return { name: 'SMTP mail', mime: 'message/rfc822' }
  if (/^(From|Path|Newsgroups|Relay-Version|Message-ID|Subject|To): /.test(firstLine) && /^(From|To|Subject|Date): .*$/m.test(head)) return { name: 'news or mail', mime: 'message/rfc822' }
  if (/^\\documentclass/m.test(head)) return { name: 'LaTeX 2e document', mime: 'text/x-tex' }
  if (/^\\(begin\{|section|chapter|usepackage|newcommand)/m.test(head)) return { name: 'LaTeX document', mime: 'text/x-tex' }
  if (/^\.(TH|SH|\\"|de|PP|nf|fi|TP|IP|RS|RE|B|I|BR|br|sp|ds|so|SS|Dd|Dt|Os|Sh)\b/m.test(head) && /^\./.test(head)) return { name: 'troff or preprocessor input', mime: 'text/troff' }
  const window = head.slice(0, 8192)
  if (/^[ \t]*import[ \t]+java\./m.test(window) || (/^package[ \t]+[\w.]+;/m.test(window) && /\bclass\b/.test(window))) return { name: 'Java source', mime: 'text/x-java' }
  if ((/^[ \t]*(class|namespace)[ \t]+\w+/m.test(window) && /[{;]/.test(window) && !/^class\s+\w+(\(.*\))?:/m.test(window)) || /^[ \t]*using[ \t]+namespace\b/m.test(window)) return { name: 'C++ source', mime: 'text/x-c++' }
  if (/^[ \t]*#[ \t]*(include|define|ifdef|ifndef|pragma)\b/m.test(window) || (/\bmain[ \t]*\([^)]*\)[ \t]*\{/.test(window) && /[{}]/.test(window))) return { name: 'C source', mime: 'text/x-c' }
  if (/^[ \t]*def[ \t]+\w+[ \t]*\(|^[ \t]*class[ \t]+\w+[ \t]*(\(.*\))?[ \t]*:[ \t]*$|^from[ \t]+[\w.]+[ \t]+import[ \t]+|^if[ \t]+__name__/m.test(window)) return { name: 'Python script', mime: 'text/x-script.python', executable: true }
  if (/^['"]use strict['"]|\bmodule\.exports\b|^[ \t]*import[ \t]+.*[ \t]from[ \t]+['"]|^[ \t]*export[ \t]+(default|const|function|class|async)\b|\bexports\.\w+[ \t]*=|\.prototype\./m.test(window)) return { name: 'JavaScript source', mime: 'text/javascript' }
  if (/^[ \t]*BEGIN[ \t]*\{/m.test(head)) return { name: 'awk or perl script', mime: 'text/plain' }
  if (/^[\w.\/$()%@+-]+[ \t]*:(?!=)[ \t]*[\w.\/$()%@+ \t-]*\n\t/m.test(head)) return { name: 'makefile script', mime: 'text/x-makefile' }
  return undefined
}

function describeText(analysis) {
  const attrs = textAttributes(analysis)
  const encText = ENCODING_TEXT[analysis.kind]
  const text = analysis.text
  const script = shebang(text)
  if (script) {
    const mime = script.generic ? 'text/plain' : SCRIPT_MIME[script.name] ?? 'text/plain'
    if (script.name === 'Perl script text executable') return { text: `${script.name}${attrs}`, mime, encoding: analysis.encoding }
    if (script.name === 'Node.js script executable') return { text: `${script.name}, ${encText}${attrs}`, mime, encoding: analysis.encoding }
    if (script.name === 'makefile script') return { text: `${script.name}, ${encText}${attrs}`, mime, encoding: analysis.encoding }
    return { text: `${script.name}, ${encText} executable${attrs}`, mime, encoding: analysis.encoding }
  }
  const found = recognise(text)
  if (found) {
    if (found.bare) return { text: found.name, mime: found.mime, encoding: analysis.encoding }
    if (found.executable) return { text: `${found.name}, ${encText} executable${attrs}`, mime: found.mime, encoding: analysis.encoding }
    return { text: `${found.name}, ${encText}${attrs}`, mime: found.mime, encoding: analysis.encoding }
  }
  return { text: `${encText}${attrs}`, mime: 'text/plain', encoding: analysis.encoding }
}

/** The part of the content that is read as text: the first 64 KiB, cut before a half-read UTF-8 character */
function textWindow(head) {
  if (head.length <= 65536) return head
  let end = 65536
  while (end > 65536 - 4 && (head[end] & 0xc0) === 0x80) end--
  return head.subarray(0, end)
}

/** @returns {{ text: string, mime: string, encoding: string }} */
export function identify(head, io) {
  if (head.length === 0) return { text: 'empty', mime: 'inode/x-empty', encoding: 'binary' }
  const known = binarySignature(head, io)
  if (known) {
    // the charset is that of the bytes read as text, binary when they are not
    if (known.mime.startsWith('application/') || known.mime.startsWith('image/')) {
      const probe = analyseText(textWindow(head))
      if (probe) known.encoding = probe.encoding
    }
    return known
  }
  const analysis = analyseText(textWindow(head))
  if (!analysis) return { text: 'data', mime: 'application/octet-stream', encoding: 'binary' }
  return describeText(analysis)
}
