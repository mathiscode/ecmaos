/**
 * Real `execve`'d `time` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/time.ts`). A real program that resolves COMMAND against PATH, then
 * `proc_spawn`s and `proc_wait`s it (real `fork()`+`execve()`/`waitpid()`, the primitives built for
 * `cron edit`), timing the whole thing. The child inherits this process's fds 0/1/2 automatically, so
 * `time cmd > file` and `time cmd | grep x` keep working with no stream plumbing here at all -- the
 * legacy version needed a hand-rolled pass-through `WritableStream` for that.
 *
 * Fallback: a target that is not a real `execve` program (a legacy `#!ecmaos:bin:command:` stub such
 * as `git`/`man`, or a name PATH can't resolve at all, e.g. a shell builtin) is run through the
 * `shell_exec` syscall instead, the same full-command-line entry point `crond` uses. That still
 * gives a true wall-clock measurement for any command the shell can run; the one loss is that such a
 * command writes to the terminal rather than through this process's redirected stdout.
 */

import { join } from './lib/path-utils.mjs'

const { argv, exit, write, custom, stat, isDirectory, getcwd, open, read, close, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: time COMMAND [ARG]...
Run COMMAND and print a summary of the real, user, and system time used.

  --help  display this help and exit

Note: This is a simplified version that measures real (wall clock) time.`

function writeStderr(text) { write(2, new TextEncoder().encode(text + '\n')) }

function formatTime(seconds) {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`
  if (seconds < 60) return `${seconds.toFixed(2)}s`
  const mins = Math.floor(seconds / 60)
  return `${mins}m${(seconds % 60).toFixed(2)}s`
}

function isFile(path) {
  try { stat(path); return !isDirectory(path) } catch { return false }
}

function resolveCommand(command) {
  const env = globalThis.ecmaosSyscalls.env
  const cwd = getcwd()
  if (command.includes('/')) {
    const full = command.startsWith('/') ? command : join(cwd, command)
    return isFile(full) ? full : undefined
  }
  const paths = (env['PATH'] || '$HOME/bin:/bin:/usr/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin').split(':')
  for (const dir of paths) {
    const expanded = dir.replace(/\$([A-Z_]+)/g, (_, name) => env[name] || '')
    const full = `${expanded}/${command}`
    if (isFile(full)) return full
  }
  return undefined
}

function isLegacyStub(path) {
  const fd = open(path, O_RDONLY)
  try {
    const buffer = new Uint8Array(24)
    const n = read(fd, buffer, -1)
    return new TextDecoder().decode(buffer.subarray(0, n)).startsWith('#!ecmaos:bin:command:')
  } finally {
    close(fd)
  }
}

const shellQuote = arg => `'${arg.replace(/'/g, `'\\''`)}'`

function report(startTime) {
  const elapsed = (performance.now() - startTime) / 1000
  writeStderr(`\nreal    ${formatTime(elapsed)}`)
  writeStderr(`user    ${formatTime(elapsed)}`)
  writeStderr(`sys     ${formatTime(0)}`)
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeStderr(usage)
    return 0
  }

  if (args.length === 0 || !args[0]) {
    writeStderr('time: missing command')
    writeStderr("Try 'time --help' for more information.")
    return 1
  }

  const command = args[0]
  const commandArgs = args.slice(1)
  const resolved = resolveCommand(command)

  const startTime = performance.now()
  let code
  try {
    if (resolved && !isLegacyStub(resolved)) {
      const pid = await custom('proc_spawn', resolved, JSON.stringify([command, ...commandArgs]), '')
      code = await custom('proc_wait', pid)
    } else {
      code = await custom('shell_exec', [command, ...commandArgs].map(shellQuote).join(' '))
    }
  } catch (error) {
    report(startTime)
    writeStderr(`time: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  report(startTime)
  return code
}

try {
  exit(await main())
} catch (error) {
  writeStderr(`time: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
