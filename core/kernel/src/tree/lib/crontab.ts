/**
 * Crontab file parsing utilities
 */

import { parseCronExpression } from 'cron-schedule'

export interface CrontabEntry {
  expression: string
  command: string
  lineNumber: number
}

/**
 * Parse a single crontab line
 * @param line - The line to parse
 * @returns Parsed entry or null if line is empty/comment
 */
export function parseCrontabLine(line: string): { expression: string, command: string } | null {
  const trimmed = line.trim()
  
  // Skip empty lines and comments
  if (trimmed === '' || trimmed.startsWith('#')) {
    return null
  }

  // Split by whitespace - cron expression is first 5 or 6 fields
  const parts = trimmed.split(/\s+/)
  
  if (parts.length < 6) {
    // Need at least 5 fields for cron expression + command
    return null
  }

  // Check if first field is a number (seconds field) or cron expression starts
  // Standard format: minute hour day month weekday command
  // Extended format: second minute hour day month weekday command
  let expression: string
  let command: string

  // A field looking like a number/range/step is necessary but not sufficient to tell a real 6th
  // (seconds) cron field apart from a 5-field expression whose command happens to start with one
  // that shape (e.g. a literal `5` as the first argument) -- so 6-field is only committed to once
  // `parseCronExpression` actually accepts it, not just because the field pattern matches.
  if (parts.length >= 7) {
    const sixField = parts.slice(0, 6).join(' ')
    try {
      parseCronExpression(sixField)
      return { expression: sixField, command: parts.slice(6).join(' ') }
    } catch {
      // Fall through to the 5-field interpretation below.
    }
  }

  // 5-field format: minute hour day month weekday command
  expression = parts.slice(0, 5).join(' ')
  command = parts.slice(5).join(' ')

  // Validate the expression
  try {
    parseCronExpression(expression)
  } catch {
    return null
  }

  return { expression, command }
}

/**
 * Parse a complete crontab file
 * @param content - The crontab file content
 * @returns Array of parsed crontab entries
 */
export function parseCrontabFile(content: string): CrontabEntry[] {
  const lines = content.split('\n')
  const entries: CrontabEntry[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const parsed = parseCrontabLine(line)
    
    if (parsed) {
      entries.push({
        expression: parsed.expression,
        command: parsed.command,
        lineNumber: i + 1
      })
    }
  }

  return entries
}
