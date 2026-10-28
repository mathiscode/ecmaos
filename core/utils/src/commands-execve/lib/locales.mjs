/**
 * The locales there are: `C`, `C.UTF-8` and `POSIX`, and one for each language the kernel has translations for, which
 * it lists in `/usr/share/i18n/SUPPORTED` at boot. The system's is `LANG` in `/etc/default/locale`, which boot reads.
 */

import { readTextFile } from './fs-text.mjs'

export const LOCALE_FILE = '/etc/default/locale'

/** `en_US.UTF-8`, ... from SUPPORTED, after the built-in ones */
export function supportedLocales() {
  let text = ''
  try { text = readTextFile('/usr/share/i18n/SUPPORTED') } catch { /* none listed */ }
  const listed = text.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(Boolean)
  return ['C.UTF-8', ...listed]
}

/** Whether `name` (with or without a charset, in either spelling) is one of them */
export function isLocale(name) {
  if (['C', 'POSIX', 'C.UTF-8', 'C.utf8'].includes(name)) return true
  const base = name.split('.')[0]
  const charset = name.split('.')[1]
  if (charset !== undefined && !/^utf-?8$/i.test(charset)) return false
  return supportedLocales().some(locale => locale.split('.')[0] === base)
}

/** The settings in `/etc/default/locale`, `NAME=value`, quotes taken off */
export function systemLocale() {
  const settings = {}
  let text = ''
  try { text = readTextFile(LOCALE_FILE) } catch { return settings }
  for (const line of text.split('\n')) {
    const match = /^\s*(LANG|LANGUAGE|LC_[A-Z]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) settings[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return settings
}
