/**
 * The numbered menu `select` prints, laid out the way bash lays it out: down the columns, as many
 * columns as fit in `columns`, each column starting on a multiple of the cell width, padded with tabs
 * where a tab stop fits and spaces for the rest. Reproducing the layout exactly matters because
 * scripts and tests compare the menu text.
 */

const digits = (n: number): number => String(n).length

export function formatSelectMenu(items: readonly string[], columns = 80): string {
  const count = items.length
  if (count === 0) return '\n'

  const longest = Math.max(...items.map(item => item.length))
  const cell = longest + digits(count) + 4
  let across = Math.max(1, Math.floor(columns / cell))
  let rows = Math.floor(count / across) + (count % across !== 0 ? 1 : 0)
  across = Math.floor(count / rows) + (count % rows !== 0 ? 1 : 0)
  if (rows === 1) { rows = across; across = 1 }

  const firstWidth = digits(rows)
  const otherWidth = digits(count)
  let out = ''
  for (let row = 0; row < rows; row++) {
    let position = 0
    let column = 0
    for (let index = row; index < count; index += rows, column++) {
      const width = column === 0 ? firstWidth : otherWidth
      const text = `${String(index + 1).padStart(width)}) ${items[index]}`
      out += text
      position += text.length
      if (index + rows >= count) break
      // Pad to the start of the next column: tabs while a tab stop still fits, then spaces.
      const target = (column + 1) * cell
      while (position < target) {
        const stop = position + (8 - (position % 8))
        if (stop <= target) { out += '\t'; position = stop } else { out += ' '; position++ }
      }
    }
    out += '\n'
  }
  return out
}
