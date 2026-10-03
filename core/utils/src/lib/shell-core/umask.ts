/**
 * The file mode creation mask a shell's `umask` builtin reads and sets: parsing what the user typed (octal
 * `022`, or symbolic `u=rwx,g=rx,o=rx`) and printing it back in either form. The symbolic form names what
 * stays *allowed*, so `umask u=rwx,g=rx,o=` is the mask 027.
 */

/** The mask a mode argument stands for, or undefined when it is not valid. `current` is what `+` and `-` start from. */
export function parseUmask(text: string, current: number): number | undefined {
  if (/^[0-7]{1,4}$/.test(text)) return parseInt(text, 8) & 0o777

  let allowed = ~current & 0o777
  for (const clause of text.split(',')) {
    const match = /^([ugoa]*)([-+=])([rwx]*)$/.exec(clause)
    if (!match) return undefined
    const who = match[1] || 'a'
    let bits = 0
    for (const permission of match[3] ?? '') bits |= permission === 'r' ? 4 : permission === 'w' ? 2 : 1
    let mask = 0
    if (who.includes('a') || who.includes('u')) mask |= bits << 6
    if (who.includes('a') || who.includes('g')) mask |= bits << 3
    if (who.includes('a') || who.includes('o')) mask |= bits
    const classes = (who.includes('a') ? 0o777 : (who.includes('u') ? 0o700 : 0) | (who.includes('g') ? 0o070 : 0) | (who.includes('o') ? 0o007 : 0))
    if (match[2] === '=') allowed = (allowed & ~classes) | mask
    else if (match[2] === '+') allowed |= mask
    else allowed &= ~mask
  }
  return ~allowed & 0o777
}

/** `0022`: four octal digits, as bash prints it. */
export function formatUmask(mask: number): string {
  return (mask & 0o777).toString(8).padStart(4, '0')
}

/** `u=rwx,g=rx,o=rx`: what the mask leaves allowed, as `umask -S` prints it. */
export function formatUmaskSymbolic(mask: number): string {
  const allowed = ~mask & 0o777
  const part = (bits: number) => `${bits & 4 ? 'r' : ''}${bits & 2 ? 'w' : ''}${bits & 1 ? 'x' : ''}`
  return `u=${part(allowed >> 6)},g=${part((allowed >> 3) & 7)},o=${part(allowed & 7)}`
}
