/**
 * Shell patterns: `*`, `?`, `[...]` with POSIX classes (`[[:digit:]]`) and `!`/`^` negation, and with `extglob`
 * the `?(a|b)`, `*(a|b)`, `+(a|b)`, `@(a|b)` and `!(a|b)` forms. Used for pathname expansion, `case`,
 * `[[ x == pattern ]]` and `${x#pattern}` alike, in both shells, so a pattern means the same everywhere.
 *
 * The `shopt` options that change what a pattern does are {@link GlobOptions}: `extglob`, `nocasematch` and
 * `nocaseglob` (case-insensitive), `dotglob` (a wildcard may match a leading dot) and `globstar` (`**`).
 * `nullglob` and `failglob` decide what happens when nothing matches, which is the expander's business.
 */

export interface GlobOptions {
  extglob?: boolean
  /** Match without regard to case (`nocasematch` for `case` and `[[`, `nocaseglob` for pathnames). */
  nocase?: boolean
  /** A wildcard may match a name that starts with a dot. */
  dotglob?: boolean
  /** `**` as a whole path segment matches any number of directories. */
  globstar?: boolean
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: 'A-Za-z0-9_', cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
}

const escapeRegExp = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** The index of the `)` that closes the extglob group opened at `open` (the `(`), or -1. */
function closeGroup(pattern: string, open: number): number {
  let depth = 0
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') { i++; continue }
    if (c === '[') {
      const end = bracketEnd(pattern, i)
      if (end !== -1) i = end
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** Splits a group's body at its top-level `|`. */
function alternatives(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string
    if (c === '\\') { current += c + (body[++i] ?? ''); continue }
    if (c === '(') depth++
    else if (c === ')') depth--
    if (c === '|' && depth === 0) { out.push(current); current = '' } else current += c
  }
  out.push(current)
  return out
}

/** The index of the `]` that closes the bracket expression opened at `open`, or -1. */
function bracketEnd(pattern: string, open: number): number {
  let i = open + 1
  if (pattern[i] === '!' || pattern[i] === '^') i++
  // a `]` right after the opening is a member, not the end
  if (pattern[i] === ']') i++
  while (i < pattern.length) {
    if (pattern[i] === '[' && pattern[i + 1] === ':') {
      const end = pattern.indexOf(':]', i + 2)
      if (end !== -1) { i = end + 2; continue }
    }
    if (pattern[i] === ']') return i
    i++
  }
  return -1
}

/** A bracket expression as a regular expression class. */
function bracketToClass(body: string): string {
  let negate = false
  let rest = body
  if (rest[0] === '!' || rest[0] === '^') { negate = true; rest = rest.slice(1) }
  let out = ''
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i] as string
    if (c === '[' && rest[i + 1] === ':') {
      const end = rest.indexOf(':]', i + 2)
      const name = end === -1 ? undefined : rest.slice(i + 2, end)
      if (name !== undefined && POSIX_CLASSES[name]) { out += POSIX_CLASSES[name]; i = end + 1; continue }
    }
    if (c === '\\' && i + 1 < rest.length) { out += escapeRegExp(rest[++i] as string); continue }
    out += c === '-' ? '-' : c === '^' ? '\\^' : c === ']' ? '\\]' : c === '[' ? '\\[' : c === '\\' ? '\\\\' : c
  }
  return `[${negate ? '^' : ''}${out}]`
}

function convert(pattern: string, options: GlobOptions): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegExp(pattern[++i] as string)
    } else if (options.extglob && '?*+@!'.includes(c) && pattern[i + 1] === '(') {
      const close = closeGroup(pattern, i + 1)
      if (close === -1) { out += escapeRegExp(c); continue }
      const group = alternatives(pattern.slice(i + 2, close)).map(alternative => convert(alternative, options)).join('|')
      const rest = convert(pattern.slice(close + 1), options)
      if (c === '!') {
        // anything that is not one of the alternatives followed by the rest of the pattern
        out += `(?:(?!(?:${group})(?:${rest})$)[\\s\\S]*?)(?:${rest})`
        return out
      }
      out += `(?:${group})${c === '@' ? '' : c}`
      i = close
    } else if (c === '*') {
      out += '.*'
    } else if (c === '?') {
      out += '.'
    } else if (c === '[') {
      const end = bracketEnd(pattern, i)
      if (end === -1) { out += '\\['; continue }
      out += bracketToClass(pattern.slice(i + 1, end))
      i = end
    } else {
      out += escapeRegExp(c)
    }
  }
  return out
}

/** The source of an anchored regular expression for `pattern`. Compile it with the `s` flag (and `i` for no case). */
export function globToRegExpSource(pattern: string, options: GlobOptions = {}): string {
  return `^${convert(pattern, options)}$`
}

/** `pattern` as a RegExp. */
export function globRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  return new RegExp(globToRegExpSource(pattern, options), options.nocase ? 'si' : 's')
}

/** Whether `text` has anything in it a pattern would treat as a wildcard. */
export function hasGlobCharacters(text: string, options: GlobOptions = {}): boolean {
  return options.extglob ? /[*?[]|[+@!]\(/.test(text) : /[*?[]/.test(text)
}

/** What pathname expansion needs from a file system; paths it is given are the pattern's own, relative or absolute. */
export interface GlobFs {
  readdir(path: string): string[] | Promise<string[]>
  isDirectory(path: string): boolean | Promise<boolean>
  exists(path: string): boolean | Promise<boolean>
}

/**
 * The paths a pattern names, sorted within each directory, spelled as the pattern spells them. Empty when
 * nothing matches: what that means (the pattern itself, nothing, an error) is the caller's.
 */
export async function globPaths(pattern: string, fs: GlobFs, options: GlobOptions = {}): Promise<string[]> {
  const absolute = pattern.startsWith('/')
  const directoriesOnly = pattern.length > 1 && pattern.endsWith('/')
  const segments = pattern.split('/').filter(Boolean)
  const join = (base: string, name: string) => base === '' ? name : base === '/' ? `/${name}` : `${base}/${name}`
  const visible = (name: string, segment: string) => !name.startsWith('.') || segment.startsWith('.') || Boolean(options.dotglob)

  /** Every directory below `base`, `base` itself included, for `**`. */
  const descend = async (base: string): Promise<string[]> => {
    const found = [base]
    let names: string[]
    try { names = await fs.readdir(base === '' ? '.' : base) } catch { return found }
    for (const name of names.sort()) {
      if (name.startsWith('.') && !options.dotglob) continue
      const path = join(base, name)
      if (await fs.isDirectory(path)) found.push(...await descend(path))
    }
    return found
  }

  let bases = [absolute ? '/' : '']
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    const next: string[] = []
    if (segment === '**' && options.globstar) {
      for (const base of bases) next.push(...await descend(base))
      bases = next
      continue
    }
    for (const base of bases) {
      if (!hasGlobCharacters(segment, options)) {
        const literal = segment.replace(/\\(.)/g, '$1')
        const candidate = join(base, literal)
        if (await fs.exists(candidate)) next.push(candidate)
        continue
      }
      let names: string[]
      try { names = await fs.readdir(base === '' ? '.' : base) } catch { continue }
      const regex = globRegExp(segment, options)
      for (const name of [...names].sort()) {
        if (!visible(name, segment) || !regex.test(name)) continue
        const candidate = join(base, name)
        if (last ? !directoriesOnly || await fs.isDirectory(candidate) : await fs.isDirectory(candidate)) next.push(candidate)
      }
    }
    bases = next
  }
  // `**` alone also names the directories themselves, which is not a match of a file pattern
  const found = segments.length === 1 && segments[0] === '**' && options.globstar ? bases.filter(base => base !== '') : bases
  // whole paths in order, as a shell sorts what a pattern expands to
  const matches = [...found].sort()
  return directoriesOnly ? matches.map(match => match + '/') : matches
}
