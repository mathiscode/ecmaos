/**
 * `/bin/su [-] [-c COMMAND] [-s SHELL] [-m] [USER]`: run a shell as another user, root by default. Root
 * is never asked for a password; anyone else is asked for the password of the user they want to become.
 *
 * The shell is a child process that runs as the target (`exit` returns to the shell that ran `su`), not
 * a change of identity in place. The program has the setuid bit: it runs as root so that it may start
 * something as someone else, and `getuid()` still says who ran it. The target's shell comes from their
 * passwd entry when that is a program, and is `/bin/ecmash` when it is the kernel's built-in shell,
 * which has no file to run.
 */

import { makePriv } from './lib/priv.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, getcwd, getuid } = sys
const priv = makePriv(sys, 'su')

const usage = `Usage: su [OPTION]... [-] [USER [ARG]...]
Run a shell as USER (root by default). Root needs no password; anyone else is asked for USER's.

  -, -l, --login           start a login shell: clean environment, in USER's home directory
  -c, --command=COMMAND    run COMMAND in the shell and exit
  -s, --shell=SHELL        run SHELL instead of USER's shell
  -m, -p, --preserve-environment
                           keep the environment (HOME, SHELL, USER and LOGNAME are still set unless -m)
  -h, --help               display this help and exit`

function parse(args) {
  const options = { login: false, command: undefined, shell: undefined, preserve: false, user: undefined, rest: [] }
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { options.help = true; return options }
    if (arg === '-' || arg === '-l' || arg === '--login') options.login = true
    else if (arg === '-c' || arg === '--command') options.command = args[++i]
    else if (arg.startsWith('--command=')) options.command = arg.slice(10)
    else if (arg === '-s' || arg === '--shell') options.shell = args[++i]
    else if (arg.startsWith('--shell=')) options.shell = arg.slice(8)
    else if (arg === '-m' || arg === '-p' || arg === '--preserve-environment') options.preserve = true
    else if (arg === '--') { i++; break }
    else if (arg.startsWith('-') && arg.length > 1) { options.bad = arg; return options }
    else break
  }
  options.user = args[i]
  options.rest = args.slice(i + 1)
  return options
}

async function main() {
  const options = parse(argv.slice(1))
  if (options.help) { priv.out(usage + '\n'); return 0 }
  if (options.bad) { priv.err(`invalid option -- '${options.bad.replace(/^-+/, '')}'`); return 2 }
  if (!await priv.supported()) return 1

  const name = options.user ?? 'root'
  const found = priv.lookup(name)
  if (!found) { priv.err(`user ${name} does not exist`); return 1 }
  const target = priv.withGroups(found)

  priv.ignoreTerminalSignals()
  if (getuid() !== 0) {
    const password = priv.askPassword('Password: ')
    if (password === null || !await priv.authenticate(target.name, password)) {
      await priv.pause(1000)
      priv.err('Authentication failure')
      return 1
    }
  }

  const shell = options.shell ?? priv.shellFor(target)
  const shellName = shell.slice(shell.lastIndexOf('/') + 1)
  const childEnv = options.login ? { TERM: env.TERM ?? 'xterm', PATH: env.PATH ?? '/bin:/usr/bin' } : { ...env }
  childEnv.HOME = target.home
  childEnv.SHELL = shell
  if (!options.preserve || options.login) { childEnv.USER = target.name; childEnv.LOGNAME = target.name }
  const shellArgv = options.command !== undefined ? [shellName, '-c', options.command, ...options.rest] : [options.login ? `-${shellName}` : shellName, ...options.rest]
  return await priv.runAs(target, shell, shellArgv, { cwd: options.login ? target.home : getcwd(), env: childEnv })
}

try {
  exit(await main())
} catch (error) {
  priv.err(error?.message ?? String(error))
  exit(1)
}
