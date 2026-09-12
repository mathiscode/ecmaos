import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'
import { parseCronExpression } from 'cron-schedule'
import cronstrue from 'cronstrue'

interface CrontabEntry {
  expression: string
  command: string
  lineNumber: number
}

/**
 * Parse a single crontab line
 * @param line - The line to parse
 * @returns Parsed entry or null if line is empty/comment
 */
function parseCrontabLine(line: string): { expression: string, command: string } | null {
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

  // Standard format: minute hour day month weekday command (5 fields + command)
  // Extended format: second minute hour day month weekday command (6 fields + command)
  // We need to determine which format is being used
  let expression: string
  let command: string

  // If we have exactly 6 parts, assume 5-field format (5 cron fields + 1 command word)
  // This is the most common case
  if (parts.length === 6) {
    // 5-field format: minute hour day month weekday command
    expression = parts.slice(0, 5).join(' ')
    command = parts[5] || ''
  } else {
    // 7+ parts: could be 5-field with multi-word command or 6-field format
    // Try 6-field format FIRST (if user wrote 6 fields, they probably meant 6 fields)
    // Then fall back to 5-field if 6-field is invalid
    const potential5Field = parts.slice(0, 5).join(' ')
    const potential6Field = parts.slice(0, 6).join(' ')
    
    let valid5Field = false
    let valid6Field = false
    
    // Try to validate 6-field format first
    try {
      parseCronExpression(potential6Field)
      valid6Field = true
    } catch {
      // Not a valid 6-field expression
    }
    
    // Try to validate 5-field format
    try {
      parseCronExpression(potential5Field)
      valid5Field = true
    } catch {
      // Not a valid 5-field expression
    }
    
    // Prefer 6-field format if valid (user wrote 6 fields, so use them)
    // Only use 5-field if 6-field is invalid
    if (valid6Field) {
      expression = potential6Field
      command = parts.slice(6).join(' ')
    } else if (valid5Field) {
      expression = potential5Field
      command = parts.slice(5).join(' ')
    } else {
      // Neither format is valid, return null
      return null
    }
  }

  // Validate the expression
  try {
    parseCronExpression(expression)
  } catch {
    return null
  }

  command = command.trim()
  return { expression, command }
}

/**
 * Parse a complete crontab file
 * @param content - The crontab file content
 * @returns Array of parsed crontab entries
 */
function parseCrontabFile(content: string): CrontabEntry[] {
  const lines = content.split('\n')
  const entries: CrontabEntry[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim()
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

/**
 * Get human-readable description of a cron expression
 * @param expression - The cron expression
 * @returns Human-readable description or null if parsing fails
 */
function getHumanReadableDescription(expression: string): string | null {
  try {
    return cronstrue.toString(expression, {
      throwExceptionOnParseError: false,
      verbose: false
    })
  } catch {
    return null
    }
}

function printUsage(io: CommandIO): void {
  const usage = `Usage: cron [COMMAND] [OPTIONS]
  
Manage scheduled tasks (crontabs).

Options:
  --help  display this help and exit

Commands:
  list                    List all active cron jobs
  add <schedule> <cmd>    Add a new cron job to user crontab
  remove <id>             Remove a cron job by ID
  edit                    Open user crontab in editor
  validate <expression>   Validate a cron expression
  next <expression> [N]   Show next N execution times (default: 1)
  test <expression>       Test if expression matches current time
  reload                  Reload crontabs from files

Examples:
  cron list                                    List all cron jobs
  cron add "*/5 * * * *" "echo hello"          Add job to run every 5 minutes
  cron add "* * * * * *" "echo hello"          Add job to run every second (6-field)
  cron add "0 0 * * *" "echo daily"            Add daily job at midnight
  cron remove cron:user:1                      Remove user cron job #1
  cron validate "*/5 * * * *"                  Validate cron expression
  cron next "*/5 * * * *" 5                    Show next 5 execution times
  cron test "*/5 * * * *"                      Test if expression matches now

Crontab format:
  Both 5-field and 6-field cron expressions are supported:
  
  5-field (standard): minute hour day month weekday command
    Example: "*/5 * * * *" runs every 5 minutes
  
  6-field (extended): second minute hour day month weekday command
    Example: "* * * * * *" runs every second
    Example: "0 */5 * * * *" runs every 5 minutes at :00 seconds`
  io.writelnErr(usage)
}

export const meta = { command: 'cron', description: 'Manage scheduled tasks (crontabs)' } as const

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    ...meta,
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length === 0 || (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h'))) {
        printUsage(io)
        return 0
      }

      const subcommand = ctx.argv[0]

      try {
        switch (subcommand) {
          case 'list': {
            const cronJobs = kernel.intervals.listCrons()
            if (cronJobs.length === 0) {
              await io.writeln('No active cron jobs.')
              return 0
            }

            // Build a map of job names to expressions by parsing crontab files
            const jobExpressions = new Map<string, { expression: string, command: string }>()

            // Load system crontab entries
            try {
              const systemCrontabPath = '/etc/crontab'
              if (await kernel.filesystem.fs.exists(systemCrontabPath)) {
                const content = await kernel.filesystem.fs.readFile(systemCrontabPath, 'utf-8')
                const entries = parseCrontabFile(content)
                for (const entry of entries) {
                  const jobName = `cron:system:${entry.lineNumber}`
                  jobExpressions.set(jobName, { expression: entry.expression, command: entry.command })
                }
              }
            } catch {
              // Ignore errors loading system crontab
            }

            // Load user crontab entries
            try {
              const home = shell.env.get('HOME') ?? '/root'
              const userCrontabPath = path.join(home, '.config', 'crontab')
              if (await shell.context.fs.promises.exists(userCrontabPath)) {
                const content = await shell.context.fs.promises.readFile(userCrontabPath, 'utf-8')
                const entries = parseCrontabFile(content)
                for (const entry of entries) {
                  const jobName = `cron:user:${entry.lineNumber}`
                  jobExpressions.set(jobName, { expression: entry.expression, command: entry.command })
                }
              }
            } catch {
              // Ignore errors loading user crontab
            }

            await io.writeln('Active cron jobs:')
            for (const jobName of cronJobs) {
              const jobInfo = jobExpressions.get(jobName)
              if (jobInfo) {
                const description = getHumanReadableDescription(jobInfo.expression)
                if (description) {
                  await io.writeln(`  ${jobName}`)
                  await io.writeln(`    Schedule: ${jobInfo.expression} (${description})`)
                  await io.writeln(`    Command: ${jobInfo.command}`)
                } else {
                  await io.writeln(`  ${jobName}`)
                  await io.writeln(`    Schedule: ${jobInfo.expression}`)
                  await io.writeln(`    Command: ${jobInfo.command}`)
                }
              } else {
                await io.writeln(`  ${jobName}`)
              }
            }
            return 0
          }

          case 'add': {
            if (ctx.argv.length < 3) {
              await io.writelnErr('cron add: missing arguments')
              await io.writelnErr('Usage: cron add <schedule> <command>')
              return 1
            }

            const schedule = ctx.argv[1]
            if (!schedule) {
              await io.writelnErr('cron add: missing schedule')
              await io.writelnErr('Usage: cron add <schedule> <command>')
              return 1
            }
            const command = ctx.argv.slice(2).join(' ')

            // Validate the cron expression
            let humanReadable: string | null = null
            try {
              parseCronExpression(schedule)
              humanReadable = getHumanReadableDescription(schedule)
            } catch (error) {
              await io.writelnErr(`cron add: invalid cron expression: ${schedule}`)
              return 1
            }

            // Get user home directory
            const home = shell.env.get('HOME') ?? '/root'
            const configDir = path.join(home, '.config')
            const crontabPath = path.join(configDir, 'crontab')

            // Ensure .config directory exists
            try {
              if (!await shell.context.fs.promises.exists(configDir)) {
                await shell.context.fs.promises.mkdir(configDir, { recursive: true })
              }
            } catch (error) {
              await io.writelnErr(`cron add: failed to create .config directory: ${error}`)
              return 1
            }

            // Read existing crontab or create new
            let crontabContent = ''
            try {
              if (await shell.context.fs.promises.exists(crontabPath)) {
                crontabContent = await shell.context.fs.promises.readFile(crontabPath, 'utf-8')
                if (!crontabContent.endsWith('\n') && crontabContent.length > 0) {
                  crontabContent += '\n'
                }
              }
            } catch (error) {
              // File doesn't exist or can't be read, start fresh
              crontabContent = ''
            }

            // Add new entry
            crontabContent += `${schedule} ${command}\n`

            // Write back to file
            try {
              await shell.context.fs.promises.writeFile(crontabPath, crontabContent, { encoding: 'utf-8' })
            } catch (error) {
              await io.writelnErr(`cron add: failed to write crontab: ${error}`)
              return 1
            }

            await io.writeln(`Added cron job: ${schedule} ${command}`)
            if (humanReadable) {
              await io.writeln(`  Schedule: ${humanReadable}`)
            }
            await io.writeln('Run "cron reload" to activate the new job.')
            return 0
          }

          case 'remove': {
            if (ctx.argv.length < 2) {
              await io.writelnErr('cron remove: missing job ID')
              await io.writelnErr('Usage: cron remove <id>')
              return 1
            }

            const jobId = ctx.argv[1]
            if (!jobId) {
              await io.writelnErr('cron remove: missing job ID')
              return 1
            }

            const handle = kernel.intervals.getCron(jobId)
            
            if (!handle) {
              await io.writelnErr(`cron remove: job not found: ${jobId}`)
              return 1
            }

            kernel.intervals.clearCron(jobId)

            // Also remove from crontab file if it's a user job
            if (jobId.startsWith('cron:user:')) {
              const home = shell.env.get('HOME') ?? '/root'
              const crontabPath = path.join(home, '.config', 'crontab')

              try {
                if (await shell.context.fs.promises.exists(crontabPath)) {
                  const content = await shell.context.fs.promises.readFile(crontabPath, 'utf-8')
                  const lines = content.split('\n')
                  const lineNumber = parseInt(jobId.replace('cron:user:', ''), 10)
                  
                  if (lineNumber > 0 && lineNumber <= lines.length) {
                    // Remove the line (1-indexed to 0-indexed)
                    const entries = parseCrontabFile(content)
                    const entryToRemove = entries.find((e: { lineNumber: number }) => e.lineNumber === lineNumber)
                    
                    if (entryToRemove) {
                      const newLines = lines.filter((_, idx) => idx + 1 !== lineNumber)
                      await shell.context.fs.promises.writeFile(crontabPath, newLines.join('\n'), { encoding: 'utf-8' })
                    }
                  }
                }
              } catch (error) {
                // Continue even if file update fails
                kernel.log.warn(`Failed to update crontab file: ${error}`)
              }
            }

            await io.writeln(`Removed cron job: ${jobId}`)
            return 0
          }

          case 'edit': {
            const home = shell.env.get('HOME') ?? '/root'
            const crontabPath = path.join(home, '.config', 'crontab')

            // Use view command to edit (or create if doesn't exist)
            const result = await kernel.execute({
              command: '/usr/bin/edit',
              args: [crontabPath],
              shell,
              terminal
            })

            if (result === 0) {
              await io.writeln('Crontab edited. Run "cron reload" to apply changes.')
            }

            return result
          }

          case 'validate': {
            if (ctx.argv.length < 2) {
              await io.writelnErr('cron validate: missing expression')
              await io.writelnErr('Usage: cron validate <expression>')
              return 1
            }

            const expression = ctx.argv[1]
            if (!expression) {
              await io.writelnErr('cron validate: missing expression')
              return 1
            }
            try {
              parseCronExpression(expression)
              const description = getHumanReadableDescription(expression)
              await io.writeln(`Valid cron expression: ${expression}`)
              if (description) {
                await io.writeln(`  Description: ${description}`)
              }
              return 0
            } catch (error) {
              await io.writelnErr(`Invalid cron expression: ${expression}`)
              await io.writelnErr(`Error: ${error instanceof Error ? error.message : String(error)}`)
              return 1
            }
          }

          case 'next': {
            if (ctx.argv.length < 2) {
              await io.writelnErr('cron next: missing expression')
              await io.writelnErr('Usage: cron next <expression> [count]')
              return 1
            }

            const expression = ctx.argv[1]
            if (!expression) {
              await io.writelnErr('cron next: missing expression')
              return 1
            }
            const count = ctx.argv.length > 2 && ctx.argv[2] ? parseInt(ctx.argv[2], 10) : 1

            if (isNaN(count) || count < 1) {
              await io.writelnErr('cron next: invalid count (must be >= 1)')
              return 1
            }

            try {
              const cron = parseCronExpression(expression)
              const now = new Date()
              const dates = cron.getNextDates(count, now)
              const description = getHumanReadableDescription(expression)

              await io.writeln(`Next ${count} execution time(s) for "${expression}":`)
              if (description) {
                await io.writeln(`  Schedule: ${description}`)
              }
              for (let i = 0; i < dates.length; i++) {
                const date = dates[i]
                if (date) {
                  await io.writeln(`  ${i + 1}. ${date.toISOString()}`)
                }
              }
              return 0
            } catch (error) {
              await io.writelnErr(`Invalid cron expression: ${expression}`)
              await io.writelnErr(`Error: ${error instanceof Error ? error.message : String(error)}`)
              return 1
            }
          }

          case 'test': {
            if (ctx.argv.length < 2) {
              await io.writelnErr('cron test: missing expression')
              await io.writelnErr('Usage: cron test <expression>')
              return 1
            }

            const expression = ctx.argv[1]
            if (!expression) {
              await io.writelnErr('cron test: missing expression')
              return 1
            }
            try {
              const cron = parseCronExpression(expression)
              const now = new Date()
              const matches = cron.matchDate(now)
              const description = getHumanReadableDescription(expression)

              if (matches) {
                await io.writeln(`Expression "${expression}" matches current time: ${now.toISOString()}`)
              } else {
                await io.writeln(`Expression "${expression}" does not match current time: ${now.toISOString()}`)
              }
              if (description) {
                await io.writeln(`  Schedule: ${description}`)
              }
              return 0
            } catch (error) {
              await io.writelnErr(`Invalid cron expression: ${expression}`)
              await io.writelnErr(`Error: ${error instanceof Error ? error.message : String(error)}`)
              return 1
            }
          }

          case 'reload': {
            // Clear all existing cron jobs
            const existingJobs = kernel.intervals.listCrons()
            for (const jobName of existingJobs) {
              kernel.intervals.clearCron(jobName)
            }

            // Reload system crontab
            try {
              const systemCrontabPath = '/etc/crontab'
              if (await kernel.filesystem.fs.exists(systemCrontabPath)) {
                const content = await kernel.filesystem.fs.readFile(systemCrontabPath, 'utf-8')
                const entries = parseCrontabFile(content)

                for (const entry of entries) {
                  const jobName = `cron:system:${entry.lineNumber}`
                  kernel.intervals.setCron(
                    jobName,
                    entry.expression,
                    async () => {
                      await kernel.shell.execute(entry.command)
                    },
                    {
                      errorHandler: (err: unknown) => {
                        kernel.log.error(`Cron job ${jobName} failed: ${err instanceof Error ? err.message : String(err)}`)
                      }
                    }
                  )
                }
              }
            } catch (error) {
              kernel.log.warn(`Failed to load system crontab: ${error}`)
            }

            // Reload user crontab
            try {
              const home = shell.env.get('HOME') ?? '/root'
              const userCrontabPath = path.join(home, '.config', 'crontab')
              
              if (await shell.context.fs.promises.exists(userCrontabPath)) {
                const content = await shell.context.fs.promises.readFile(userCrontabPath, 'utf-8')
                const entries = parseCrontabFile(content)

                for (const entry of entries) {
                  const jobName = `cron:user:${entry.lineNumber}`
                  // Ensure command is properly trimmed and preserved
                  const command = entry.command.trim()
                  kernel.intervals.setCron(
                    jobName,
                    entry.expression,
                    async () => {
                      await kernel.shell.execute(command)
                    },
                    {
                      errorHandler: (err: unknown) => {
                        kernel.log.error(`Cron job ${jobName} failed: ${err instanceof Error ? err.message : String(err)}`)
                      }
                    }
                  )
                }
              }
            } catch (error) {
              kernel.log.warn(`Failed to load user crontab: ${error}`)
            }

            await io.writeln('Crontabs reloaded.')
            return 0
          }

          default:
            await io.writelnErr(`cron: unknown command: ${subcommand}`)
            await io.writelnErr("Try 'cron --help' for more information.")
            return 1
        }
      } catch (error) {
        await io.writelnErr(`cron: error: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }
  })
}
