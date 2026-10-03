/**
 * Print the environment, or run a command in a modified one. The shells have `env` as a builtin;
 * this is the program behind `/usr/bin/env`, which `#!/usr/bin/env bash` scripts name.
 */

const { argv, env, exit, writeAll, stat, isDirectory, spawn, waitpid, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]
Print the environment, or run COMMAND with it changed.

  -i, --ignore-environment  start with an empty environment
  -u, --unset=NAME          remove NAME from the environment
  -0, --null                end each printed line with NUL, not a newline
  --help                    display this help and exit`

function findProgram(name) {
  const isFile = path => { try { return !isDirectory(path) && (stat(path), true) } catch { return false } }
  if (name.includes('/')) return isFile(name) ? name : undefined
  for (const dir of (env.PATH ?? '/bin:/usr/bin').split(':')) {
    if (!dir) continue
    const candidate = `${dir}/${name}`
    if (isFile(candidate)) return candidate
  }
  return undefined
}

async function main() {
  const args = argv.slice(1)
  let vars = { ...env }
  let terminator = '\n'
  let i = 0

  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { err(usage); return 0 }
    if (arg === '-i' || arg === '--ignore-environment' || arg === '-') vars = {}
    else if (arg === '-0' || arg === '--null') terminator = '\0'
    else if (arg === '-u' || arg === '--unset') {
      const name = args[++i]
      if (name === undefined) { err('env: option requires an argument -- \'u\''); return 125 }
      delete vars[name]
    } else if (arg.startsWith('--unset=')) delete vars[arg.slice(8)]
    else if (arg === '--') { i++; break }
    else if (arg.startsWith('-') && arg.length > 1) { err(`env: invalid option -- '${arg.replace(/^-+/, '')}'`); return 125 }
    else break
  }

  for (; i < args.length; i++) {
    const eq = args[i].indexOf('=')
    if (eq <= 0) break
    vars[args[i].slice(0, eq)] = args[i].slice(eq + 1)
  }

  const command = args.slice(i)
  if (!command.length) {
    writeAll(1, encoder.encode(Object.entries(vars).map(([name, value]) => `${name}=${value}${terminator}`).join('')))
    return 0
  }

  const program = findProgram(command[0])
  if (!program) { err(`env: '${command[0]}': No such file or directory`); return 127 }
  const pid = await spawn(program, command, { env: vars, fds: { 0: 0, 1: 1, 2: 2 }, cwd: getcwd() })
  const done = await waitpid(pid, false)
  return done.signal ? 128 + done.signal : done.code
}

try {
  exit(await main())
} catch (error) {
  err(`env: ${error instanceof Error ? error.message : String(error)}`)
  exit(125)
}
