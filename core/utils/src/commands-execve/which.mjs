/**
 * Real `execve`'d `which` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/which.ts`) per `feat/1.0.0-execve-commands`. `shell.env.get('PATH')` is
 * replaced by `env.PATH` (from the real `init` message, matching every other migrated command's
 * `env` usage).
 */

import { resolve, join } from './lib/path-utils.mjs'

const { argv, exit, writeAll, getcwd, env, stat } = globalThis.ecmaosSyscalls

const usage = `Usage: which [COMMAND]...
Locate a command.

  COMMAND  the command(s) to locate
  --help  display this help and exit`

function exists(path) {
  try { stat(path); return true } catch { return false }
}

function resolveCommand(cwd, command) {
  if (command.startsWith('./')) {
    const cwdCommand = join(cwd, command.slice(2))
    return exists(cwdCommand) ? cwdCommand : undefined
  }

  const paths = (env.PATH || '').split(':').filter(Boolean)
  const searchPaths = paths.length > 0 ? paths : ['/bin', '/usr/bin', '/usr/local/bin']
  const resolvedCommand = resolve(cwd, command)

  if (command.startsWith('/') && exists(resolvedCommand)) return resolvedCommand

  for (const pathDir of searchPaths) {
    const expandedPath = pathDir.replace(/\$([A-Z_]+)/g, (_, name) => env[name] || '')
    const fullPath = `${expandedPath}/${command}`
    if (exists(fullPath)) return fullPath
  }

  return undefined
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const commands = args.filter(arg => arg !== '--help' && arg !== '-h' && !arg.startsWith('-'))

  if (commands.length === 0) {
    writeAll(2, new TextEncoder().encode('which: missing command name\n'))
    return 1
  }

  const cwd = getcwd()
  let exitCode = 0
  let output = ''

  for (const cmd of commands) {
    const commandPath = resolveCommand(cwd, cmd)
    if (commandPath) {
      output += commandPath + '\n'
    } else {
      exitCode = 1
    }
  }

  writeAll(1, new TextEncoder().encode(output))
  return exitCode
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`which: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
