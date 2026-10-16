/**
 * Freedesktop `.desktop` entries (https://specifications.freedesktop.org/desktop-entry-spec/latest/): the launcher's
 * applications. Only the keys a launcher needs are read.
 */

export interface DesktopEntry {
  /** The file name without `.desktop` */
  id: string
  name: string
  comment?: string
  /** The `Exec` line with its field codes removed */
  exec: string
  /** Run in a terminal window */
  terminal: boolean
  icon?: string
  categories: string[]
}

const truthy = (value: string | undefined) => value === 'true' || value === '1'

/** Unescapes `\s`, `\n`, `\t`, `\r` and `\\` in a value */
const unescape = (value: string) => value.replace(/\\([snrt\\])/g, (_, char: string) => ({ s: ' ', n: '\n', r: '\r', t: '\t', '\\': '\\' })[char] ?? char)

/**
 * Reads the `[Desktop Entry]` group. Returns nothing for an entry that is not an application, is hidden (`Hidden`,
 * `NoDisplay`), has no `Name` or `Exec`, or is limited to other desktops (`OnlyShowIn` without `ecmaOS`).
 */
export function parseDesktopEntry(id: string, text: string): DesktopEntry | undefined {
  const values: Record<string, string> = {}
  let inEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const group = /^\[(.+)\]$/.exec(line)
    if (group) { inEntry = group[1] === 'Desktop Entry'; continue }
    if (!inEntry) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const key = line.slice(0, equals).trim()
    // Localized keys (`Name[de]`) are not used
    if (key.includes('[')) continue
    values[key] = line.slice(equals + 1).trim()
  }

  if (values['Type'] !== 'Application' || truthy(values['Hidden']) || truthy(values['NoDisplay'])) return undefined
  const name = values['Name'] ? unescape(values['Name']) : undefined
  const exec = values['Exec'] ? stripFieldCodes(values['Exec']) : undefined
  if (!name || !exec) return undefined

  const only = values['OnlyShowIn']?.split(';').filter(Boolean)
  if (only?.length && !only.includes('ecmaOS')) return undefined
  if (values['NotShowIn']?.split(';').includes('ecmaOS')) return undefined

  return {
    id,
    name,
    comment: values['Comment'] ? unescape(values['Comment']) : undefined,
    exec,
    terminal: truthy(values['Terminal']),
    icon: values['Icon'],
    categories: values['Categories']?.split(';').filter(Boolean) ?? []
  }
}

/**
 * Removes the field codes (`%f`, `%U`, `%i` and the rest) from an `Exec` line and collapses the space they leave;
 * `%%` is a literal percent sign. There are no files to pass when launching from a menu.
 */
export function stripFieldCodes(exec: string): string {
  return exec
    .replace(/%(.)/g, (_, code: string) => code === '%' ? '\u0000' : '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\u0000/g, '%')
}
