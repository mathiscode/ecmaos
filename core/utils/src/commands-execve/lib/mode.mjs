/**
 * Permission modes as GNU `chmod` and `mkdir -m` read them: octal (`755`, `0644`, `4755`) or symbolic clauses
 * (`u+rwx,g=rx,o-w`, `a+X`, `g=u`, `+t`). `compile` returns a function from the old mode to the new one, or
 * `undefined` for text that is no mode. A symbolic clause without a class applies the process umask, so `+w` under
 * a 022 umask only gives the owner write access. A directory keeps its setuid and setgid bits unless the mode names
 * them (an `s`, or an octal mode of five or more digits).
 */

const S_ISUID = 0o4000
const S_ISGID = 0o2000
const S_ISVTX = 0o1000
const ALL = 0o7777

const CLASS_BITS = {
  u: S_ISUID | 0o700,
  g: S_ISGID | 0o070,
  o: S_ISVTX | 0o007
}

/** `rw-r--r--`, with `s`/`S` and `t`/`T` folded into the execute positions, as `ls -l` shows a mode */
export function permString(mode) {
  const chars = 'rwxrwxrwx'.split('').map((letter, i) => (mode & (0o400 >> i) ? letter : '-'))
  if (mode & S_ISUID) chars[2] = mode & 0o100 ? 's' : 'S'
  if (mode & S_ISGID) chars[5] = mode & 0o010 ? 's' : 'S'
  if (mode & S_ISVTX) chars[8] = mode & 0o001 ? 't' : 'T'
  return chars.join('')
}

/** `0644 (rw-r--r--)`, the form `chmod -v` reports */
export function describe(mode) {
  return `${(mode & ALL).toString(8).padStart(4, '0')} (${permString(mode)})`
}

/**
 * @param {string} text the mode as typed
 * @param {number} umask the process umask, applied to clauses that name no class
 * @returns {((old: number, isDir: boolean) => number) | undefined}
 */
export function compile(text, umask = 0o022) {
  if (text === '') return undefined
  if (/^[0-7]+$/.test(text)) {
    const value = parseInt(text, 8)
    if (value > ALL) return undefined
    // fewer than five digits leave a directory's setuid and setgid bits as they were
    const keepSetid = text.length < 5
    return (old, isDir) => (isDir && keepSetid ? (value & ~(S_ISUID | S_ISGID)) | (old & (S_ISUID | S_ISGID)) : value)
  }

  const clauses = []
  for (const clause of text.split(',')) {
    const head = /^[ugoa]*/.exec(clause)[0]
    let rest = clause.slice(head.length)
    if (rest === '') return undefined
    let affected = 0
    for (const who of head) {
      if (who === 'a') affected |= CLASS_BITS.u | CLASS_BITS.g | CLASS_BITS.o
      else affected |= CLASS_BITS[who]
    }
    const operations = []
    while (rest !== '') {
      const op = rest[0]
      if (op !== '+' && op !== '-' && op !== '=') return undefined
      rest = rest.slice(1)
      const perms = /^[ugo]/.test(rest) ? rest[0] : /^[rwxXst]*/.exec(rest)[0]
      rest = rest.slice(perms.length)
      // `u+r-w` is two operations; a copy source takes the single letter
      operations.push({ op, perms })
    }
    clauses.push({ head, affected, operations })
  }

  return (old, isDir) => {
    let mode = old & ALL
    for (const { head, affected, operations } of clauses) {
      for (const { op, perms } of operations) {
        // the bits this clause names, and whether it touches setid bits explicitly
        const classless = head === ''
        const reach = classless ? ALL & ~umask : affected
        let value = 0
        if (/^[ugo]$/.test(perms)) {
          const source = (mode >> (perms === 'u' ? 6 : perms === 'g' ? 3 : 0)) & 7
          value = source << 6 | source << 3 | source
        } else {
          if (perms.includes('r')) value |= 0o444
          if (perms.includes('w')) value |= 0o222
          if (perms.includes('x')) value |= 0o111
          if (perms.includes('X') && (isDir || mode & 0o111)) value |= 0o111
          if (perms.includes('s')) value |= S_ISUID | S_ISGID
          if (perms.includes('t')) value |= S_ISVTX
        }
        const mask = classless ? (ALL & ~umask) | (perms.includes('s') ? S_ISUID | S_ISGID : 0) | (perms.includes('t') ? S_ISVTX : 0) : reach
        const applied = value & mask
        if (op === '+') mode |= applied
        else if (op === '-') mode &= ~applied
        else {
          // `=` replaces everything the clause names; a directory keeps setid unless `s` is mentioned
          let clear = classless ? 0o777 | S_ISVTX : affected
          if (!isDir || perms.includes('s')) clear |= classless ? S_ISUID | S_ISGID : affected & (S_ISUID | S_ISGID)
          else clear &= ~(S_ISUID | S_ISGID)
          mode = (mode & ~clear) | applied
        }
      }
    }
    return mode & ALL
  }
}
