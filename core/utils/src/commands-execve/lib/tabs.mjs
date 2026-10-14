/** Tab stops for `expand` and `unexpand`: `-t 4` (every 4 columns) or `-t 2,6,10` (those columns, and nothing after the last). */

/** `{ every }` or `{ list }` for the text of `-t`, or an error text */
export function parseTabs(text) {
  if (!/^\d+(,\d+)*$/.test(text ?? '')) return { error: `tab size contains invalid character(s): '${text ?? ''}'` }
  const numbers = text.split(',').map(Number)
  if (numbers.length === 1 && numbers[0] === 0) return { error: 'tab size cannot be 0' }
  for (let i = 1; i < numbers.length; i++) if (numbers[i] <= numbers[i - 1]) return { error: 'tab sizes must be ascending' }
  return numbers.length === 1 ? { every: numbers[0] } : { list: numbers }
}

/** The column of the next tab stop after `column`, or `undefined` when the list has no more */
export function nextStop(tabs, column) {
  if (tabs.every) return (Math.floor(column / tabs.every) + 1) * tabs.every
  return tabs.list.find(stop => stop > column)
}

/** A byte that starts a character: the bytes of a UTF-8 sequence after the first take no column */
export const startsCharacter = code => (code & 0xc0) !== 0x80
