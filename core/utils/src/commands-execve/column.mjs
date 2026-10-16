/**
 * `column`: columnate lists, as util-linux's column does. Without `-t` the input lines are laid out in as many columns as fit the
 * width (`-c`, 80 by default), filled down the columns or, with `-x`, along the rows, with tabs between them. With `-t` the lines
 * are split into fields (blanks, or each character of `-s`) and made into a table: `-o` the separator, `-N` column names, `-R` right
 * alignment, `-H` hidden columns, `-O` the order, `-J` JSON output.
 */

import { readFdBytes, readFileBytes, writeFdBytes } from './lib/bytes.mjs'
import { getopt } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { resolve } from './lib/path-utils.mjs'

const { argv, env, exit, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeFdBytes(2, encoder.encode(`column: ${text}\n`))
const out = text => writeFdBytes(1, encoder.encode(text))

const usage = `
Usage:
 column [options] [<file>...]

Columnate lists.

Options:
 -t, --table                      create a table
 -n, --table-name <name>          table name for JSON output
 -O, --table-order <columns>      specify order of output columns
 -C, --table-column <properties>  define column
 -N, --table-columns <names>      comma separated columns names
 -l, --table-columns-limit <num>  maximal number of input columns
 -E, --table-noextreme <columns>  don't count long text from the columns to column width
 -d, --table-noheadings           don't print header
 -e, --table-header-repeat        repeat header for each page
 -H, --table-hide <columns>       don't print specified columns
 -R, --table-right <columns>      right align text in these columns
 -T, --table-truncate <columns>   truncate text in the columns when necessary
 -W, --table-wrap <columns>       wrap text in the columns when necessary
 -L, --keep-empty-lines           always print empty lines
 -J, --json                       use JSON output format for table

 -r, --tree <column>              column to use tree-like output for the table
 -i, --tree-id <column>           line ID to specify child-parent relation
 -p, --tree-parent <column>       parent to specify child-parent relation

 -c, --output-width <width>       width of output in number of characters
 -o, --output-separator <string>  columns separator for table output (default is two spaces)
 -s, --separator <string>         possible table delimiters
 -x, --fillrows                   fill rows before columns

 -h, --help                       display this help
 -V, --version                    display version

For more details see column(1).
`

class ColumnError extends Error {}

/** Which columns a list names: numbers (1 is the first), names, or `0`/`-` for all */
function columnList(text, names) {
  return text.split(',').filter(Boolean).map(item => {
    if (/^\d+$/.test(item)) return Number(item) - 1
    const index = names.indexOf(item)
    if (index < 0) throw new ColumnError(`undefined column name '${item}'`)
    return index
  })
}

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'tn:O:C:N:l:E:deH:R:T:W:LJr:i:p:c:o:s:xhV',
    long: {
      table: 't', 'table-name': { key: 'n', arg: 'required' }, 'table-order': { key: 'O', arg: 'required' }, 'table-column': { key: 'C', arg: 'required' }, 'table-columns': { key: 'N', arg: 'required' },
      'table-columns-limit': { key: 'l', arg: 'required' }, 'table-noextreme': { key: 'E', arg: 'required' }, 'table-noheadings': 'd', 'table-header-repeat': 'e', 'table-hide': { key: 'H', arg: 'required' },
      'table-right': { key: 'R', arg: 'required' }, 'table-truncate': { key: 'T', arg: 'required' }, 'table-wrap': { key: 'W', arg: 'required' }, 'keep-empty-lines': 'L', json: 'J',
      tree: { key: 'r', arg: 'required' }, 'tree-id': { key: 'i', arg: 'required' }, 'tree-parent': { key: 'p', arg: 'required' }, 'output-width': { key: 'c', arg: 'required' },
      'output-separator': { key: 'o', arg: 'required' }, separator: { key: 's', arg: 'required' }, fillrows: 'x', help: 'h', version: 'V'
    }
  })
  if (error) { err(error); writeFdBytes(2, encoder.encode("Try 'column --help' for more information.\n")); return 1 }
  const o = { table: false, name: undefined, order: undefined, names: undefined, hide: undefined, right: undefined, noHeadings: false, keepEmpty: false, json: false, width: undefined, outputSeparator: '  ', separator: undefined, fillRows: false, limit: Infinity, tableOnly: false }
  try {
    for (const [key, value] of options) {
      if (key === 'h') { out(usage); return 0 }
      if (key === 'V') { out('column from util-linux (ecmaOS)\n'); return 0 }
      if (key === 't') o.table = true
      else if (key === 'n') { o.name = value; o.tableOnly = true }
      else if (key === 'O') { o.order = value; o.tableOnly = true }
      else if (key === 'N') { o.names = value.split(','); o.tableOnly = true }
      else if (key === 'H') { o.hide = value; o.tableOnly = true }
      else if (key === 'R') { o.right = value; o.tableOnly = true }
      else if (key === 'd') { o.noHeadings = true; o.tableOnly = true }
      else if (key === 'l') { o.limit = Number(value); o.tableOnly = true }
      else if (key === 'E' || key === 'C' || key === 'T' || key === 'W' || key === 'e' || key === 'r' || key === 'i' || key === 'p') o.tableOnly = true
      else if (key === 'L') o.keepEmpty = true
      else if (key === 'J') { o.json = true; o.table = true }
      else if (key === 'c') { o.width = Number(value); if (!Number.isInteger(o.width) || o.width <= 0) throw new ColumnError(`invalid output width argument: ${value}`) }
      else if (key === 'o') o.outputSeparator = value
      else if (key === 's') o.separator = value
      else if (key === 'x') o.fillRows = true
    }
    if (o.tableOnly && !o.table) throw new ColumnError('option --table required for all --table-*')
    // the input
    const cwd = getcwd()
    const lines = []
    let failed = false
    for (const name of operands.length ? operands : ['-']) {
      let bytes
      try { bytes = name === '-' ? readFdBytes(0) : readFileBytes(resolve(cwd, name)) } catch (e) { err(`${name}: ${reasonOf(e)}`); failed = true; continue }
      const text = new TextDecoder().decode(bytes)
      const pieces = text.split('\n')
      if (pieces[pieces.length - 1] === '') pieces.pop()
      lines.push(...pieces)
    }
    if (failed && lines.length === 0) return 1
    const status = failed ? 1 : 0
    if (o.table) return table(o, lines) || status
    return fill(o, lines) || status
  } catch (e) {
    if (e instanceof ColumnError) { err(e.message); return 1 }
    throw e
  }
}

const width = text => Array.from(text).length

function fill(o, lines) {
  const entries = lines.filter(line => line !== '' || o.keepEmpty)
  if (entries.length === 0) return 0
  const termWidth = o.width ?? (Number(env.COLUMNS) || 80)
  const maxlen = Math.max(...entries.map(width))
  const colwidth = (Math.floor(maxlen / 8) + 1) * 8
  let columns = Math.max(1, Math.floor(termWidth / colwidth))
  let rows = Math.ceil(entries.length / columns)
  if (o.fillRows) columns = Math.min(columns, entries.length)
  else columns = Math.ceil(entries.length / rows)
  let text = ''
  for (let r = 0; r < (o.fillRows ? Math.ceil(entries.length / columns) : rows); r++) {
    let line = ''
    for (let c = 0; c < columns; c++) {
      const index = o.fillRows ? r * columns + c : c * rows + r
      if (index >= entries.length) break
      const next = o.fillRows ? r * columns + c + 1 : (c + 1) * rows + r
      const cell = entries[index]
      line += cell
      if (c < columns - 1 && next < entries.length) {
        let w = width(cell)
        while (w < colwidth) { line += '\t'; w = (Math.floor(w / 8) + 1) * 8 }
      }
    }
    text += line + '\n'
  }
  out(text)
  return 0
}

function table(o, lines) {
  const rows = []
  for (const line of lines) {
    if (line === '' && !o.keepEmpty) continue
    let fields
    if (o.separator !== undefined) {
      fields = []
      let current = ''
      for (const ch of line) {
        if (o.separator.includes(ch) && fields.length < o.limit - 1) { fields.push(current); current = '' } else current += ch
      }
      fields.push(current)
    } else {
      const trimmed = line.trim()
      fields = trimmed === '' ? [] : trimmed.split(/[ \t]+/)
      if (fields.length > o.limit) fields = [...fields.slice(0, o.limit - 1), fields.slice(o.limit - 1).join(' ')]
    }
    rows.push(fields)
  }
  if (rows.length === 0 && !o.names) return 0
  const count = Math.max(o.names?.length ?? 0, ...rows.map(row => row.length))
  const names = o.names ? [...o.names] : undefined
  const nameList = names ?? Array.from({ length: count }, (_, i) => `COLUMN${i + 1}`)
  while (nameList.length < count) nameList.push(`COLUMN${nameList.length + 1}`)
  const hidden = new Set(o.hide ? columnList(o.hide, nameList) : [])
  const right = new Set(o.right ? columnList(o.right, nameList) : [])
  let order = Array.from({ length: count }, (_, i) => i).filter(i => !hidden.has(i))
  if (o.order) order = columnList(o.order, nameList)
  if (o.json) {
    const objects = rows.map(row => `{\n${order.map(i => `         ${JSON.stringify(nameList[i])}: ${JSON.stringify(row[i] ?? null).replace(/^null$/, 'null')}`).join(',\n')}\n      }`)
    out(`{\n   "${o.name ?? 'table'}": [\n      ${objects.join(',')}\n   ]\n}\n`)
    return 0
  }
  const all = names && !o.noHeadings ? [names.slice(0, count), ...rows] : rows
  const widths = order.map(i => Math.max(0, ...all.map(row => width(row[i] ?? ''))))
  let text = ''
  for (const row of all) {
    const cells = order.map((i, position) => {
      const value = row[i] ?? ''
      if (position === order.length - 1 && !right.has(i)) return value
      return right.has(i) ? ' '.repeat(Math.max(0, widths[position] - width(value))) + value : value + ' '.repeat(Math.max(0, widths[position] - width(value)))
    })
    text += cells.join(o.outputSeparator) + '\n'
  }
  out(text)
  return 0
}

try {
  exit(main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
