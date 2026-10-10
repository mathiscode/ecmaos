/**
 * Colors for `ls --color`, as GNU `ls` picks them: `$LS_COLORS` when set (`di=01;34:*.tar=01;31:...`), the
 * usual defaults when not. The pure part, so it is tested without a terminal.
 */

const S_IFMT = 0o170000

/** The defaults of GNU `dircolors` for the types, and the file extensions people expect to stand out. */
const DEFAULT_LS_COLORS = [
  'di=01;34', 'ln=01;36', 'pi=40;33', 'so=01;35', 'bd=40;33;01', 'cd=40;33;01', 'su=37;41', 'sg=30;43', 'tw=30;42', 'ow=34;42', 'st=37;44', 'ex=01;32',
  ...['tar', 'tgz', 'zip', 'gz', 'bz2', 'xz', '7z', 'rar', 'deb'].map(extension => `*.${extension}=01;31`),
  ...['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'mp4', 'mkv', 'webm'].map(extension => `*.${extension}=01;35`),
  ...['mp3', 'ogg', 'wav', 'flac'].map(extension => `*.${extension}=00;36`),
].join(':')

export interface LsColors { types: Map<string, string>, extensions: Map<string, string> }

/** Parses an `$LS_COLORS` value. An entry that is not `key=codes` is ignored. */
export function parseLsColors(text: string | undefined): LsColors {
  const colors: LsColors = { types: new Map(), extensions: new Map() }
  for (const entry of (text ?? DEFAULT_LS_COLORS).split(':')) {
    const equals = entry.indexOf('=')
    if (equals < 1) continue
    const key = entry.slice(0, equals)
    const codes = entry.slice(equals + 1)
    if (key.startsWith('*.')) colors.extensions.set(key.slice(2).toLowerCase(), codes)
    else colors.types.set(key, codes)
  }
  return colors
}

/** The SGR codes for an entry, or undefined when it is plain. */
export function colorFor(entry: { name: string, mode: number }, colors: LsColors): string | undefined {
  const mode = entry.mode
  const type = mode & S_IFMT
  const pick = (key: string) => colors.types.get(key)
  switch (type) {
    case 0o120000: return pick('ln')
    case 0o040000: {
      const sticky = (mode & 0o1000) !== 0
      const otherWritable = (mode & 0o002) !== 0
      if (sticky && otherWritable) return pick('tw') ?? pick('di')
      if (otherWritable) return pick('ow') ?? pick('di')
      if (sticky) return pick('st') ?? pick('di')
      return pick('di')
    }
    case 0o020000: return pick('cd')
    case 0o060000: return pick('bd')
    case 0o010000: return pick('pi')
    case 0o140000: return pick('so')
  }
  if (mode & 0o4000) return pick('su') ?? pick('ex')
  if (mode & 0o2000) return pick('sg') ?? pick('ex')
  if (mode & 0o111) return pick('ex')
  const dot = entry.name.lastIndexOf('.')
  return dot > 0 ? colors.extensions.get(entry.name.slice(dot + 1).toLowerCase()) : undefined
}

/** `text` in `codes`, reset after; plain when there are no codes. */
export const paint = (text: string, codes: string | undefined): string => codes ? `\x1b[${codes}m${text}\x1b[0m` : text
