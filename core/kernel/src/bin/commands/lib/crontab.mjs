/**
 * Crontab-line parsing shared between `crond.mjs` (the real scheduler) and `cron.mjs` (the
 * `crontab`-shaped inspection/editing CLI) -- a straight port of the legacy `cron.ts`'s own
 * `parseCrontabLine`/`parseCrontabFile`, minus anything that only one of the two needs.
 */

import { parseCronExpression } from 'cron-schedule'

/** Parse a single crontab line -- `null` for an empty line, a comment, or something unparseable. */
export function parseCrontabLine(line) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null

  const parts = trimmed.split(/\s+/)
  if (parts.length < 6) return null

  let expression
  let command

  if (parts.length === 6) {
    // 5-field format: minute hour day month weekday command
    expression = parts.slice(0, 5).join(' ')
    command = parts[5] ?? ''
  } else {
    // 7+ parts: try the 6-field (extended, with seconds) format first, since the user wrote 6
    // fields; fall back to 5-field only if 6-field doesn't parse.
    const potential5Field = parts.slice(0, 5).join(' ')
    const potential6Field = parts.slice(0, 6).join(' ')

    let valid6Field = false
    try { parseCronExpression(potential6Field); valid6Field = true } catch { /* not 6-field */ }

    let valid5Field = false
    try { parseCronExpression(potential5Field); valid5Field = true } catch { /* not 5-field */ }

    if (valid6Field) {
      expression = potential6Field
      command = parts.slice(6).join(' ')
    } else if (valid5Field) {
      expression = potential5Field
      command = parts.slice(5).join(' ')
    } else {
      return null
    }
  }

  try {
    parseCronExpression(expression)
  } catch {
    return null
  }

  return { expression, command: command.trim() }
}

/** Parse a complete crontab file's content into `{ expression, command, lineNumber }` entries. */
export function parseCrontabFile(content) {
  const lines = content.split('\n')
  const entries = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim()
    if (!line) continue
    const parsed = parseCrontabLine(line)
    if (parsed) entries.push({ expression: parsed.expression, command: parsed.command, lineNumber: i + 1 })
  }

  return entries
}
