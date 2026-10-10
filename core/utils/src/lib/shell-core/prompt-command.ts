/**
 * `PROMPT_COMMAND`: shell text the interactive shell runs just before it draws each primary prompt.
 * bash also accepts an array, whose elements run in index order, so both spellings are read here.
 */

import type { ShellState } from './state.js'

export function promptCommands(state: ShellState): string[] {
  const array = state.lookupArray('PROMPT_COMMAND')
  if (array && array.size > 0) {
    return [...array.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([, text]) => text).filter(text => text.trim() !== '')
  }
  const scalar = state.lookup('PROMPT_COMMAND')
  return scalar && scalar.trim() !== '' ? [scalar] : []
}
