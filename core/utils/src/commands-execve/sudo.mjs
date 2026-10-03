/**
 * `/bin/sudo [-u USER] [-i | -s] [-n] [-S] [-k | -K] [-v] [-l] [--] [COMMAND [ARG]...]`: run a command as
 * another user, root by default, if `/etc/sudoers` allows it. The password asked for is the caller's own
 * (not the target's), and is remembered for `timestamp_timeout` minutes (5 by default) so a run of
 * commands asks once. Root is never asked.
 *
 * It has the setuid bit: it runs as root so that it can read `/etc/sudoers` (mode 0440) and start
 * something as someone else, while `getuid()` still says who ran it. See `lib/sudoers.ts` for the part of
 * the file's grammar that is understood.
 *
 * The remembered password is a file per user in `/run/sudo/ts`, which a user cannot touch (that
 * directory is root's, mode 0700) and which does not outlive a reboot.
 */

import { checkSudo, listPrivileges, parseSudoers } from '../lib/sudoers.ts'
import { makePriv } from './lib/priv.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, getcwd, getuid, mkdir, open, close, unlink, writeAll, O_WRONLY, O_CREAT, O_TRUNC } = sys
const priv = makePriv(sys, 'sudo')

const usage = `Usage: sudo [OPTION]... [--] COMMAND [ARG]...
       sudo [OPTION]... -i | -s [COMMAND [ARG]...]
Run COMMAND as another user (root by default) if /etc/sudoers allows it.

  -u, --user=USER     run as USER
  -i, --login         run USER's login shell, in their home directory
  -s, --shell         run USER's shell
  -n, --non-interactive  never ask for a password; fail if one is needed
  -S, --stdin         read the password from standard input, not the terminal
  -k, -K              forget the remembered password
  -v                  remember the password without running anything
  -l, --list          list what the caller may run
  -h, --help          display this help and exit`

const encoder = new TextEncoder()
const TIMESTAMPS = '/run/sudo/ts'

function parse(args) {
  const options = { user: 'root', login: false, shell: false, noninteractive: false, stdin: false, kill: false, validate: false, list: false, command: [] }
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (arg === '--help' || arg === '-h') { options.help = true; return options }
    if (arg === '-u' || arg === '--user') options.user = args[++i]
    else if (arg.startsWith('--user=')) options.user = arg.slice(7)
    else if (arg === '-i' || arg === '--login') options.login = true
    else if (arg === '-s' || arg === '--shell') options.shell = true
    else if (arg === '-n' || arg === '--non-interactive') options.noninteractive = true
    else if (arg === '-S' || arg === '--stdin') options.stdin = true
    else if (arg === '-k' || arg === '-K') options.kill = true
    else if (arg === '-v') options.validate = true
    else if (arg === '-l' || arg === '--list') options.list = true
    else if (arg === '-H' || arg === '-E') continue
    else if (arg.startsWith('-') && arg.length > 1) { options.bad = arg; return options }
    else break
  }
  options.command = args.slice(i)
  return options
}

function remembered(uid, timeoutMinutes) {
  if (timeoutMinutes === 0) return false
  const text = priv.readFile(`${TIMESTAMPS}/${uid}`)
  if (!text) return false
  const stamp = Number(text)
  return Number.isFinite(stamp) && (timeoutMinutes < 0 || Date.now() - stamp < timeoutMinutes * 60000)
}

function remember(uid) {
  try { mkdir('/run/sudo', 0o700) } catch { /* there */ }
  try { mkdir(TIMESTAMPS, 0o700) } catch { /* there */ }
  const fd = open(`${TIMESTAMPS}/${uid}`, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
  try { writeAll(fd, encoder.encode(String(Date.now()))) } finally { close(fd) }
}

function forget(uid) {
  try { unlink(`${TIMESTAMPS}/${uid}`) } catch { /* nothing remembered */ }
}

async function main() {
  const options = parse(argv.slice(1))
  if (options.help) { priv.out(usage + '\n'); return 0 }
  if (options.bad) { priv.err(`invalid option -- '${options.bad.replace(/^-+/, '')}'`); return 1 }
  if (!await priv.supported()) return 1
  priv.ignoreTerminalSignals()

  const uid = getuid()
  const found = priv.lookup(uid)
  if (!found) { priv.err(`you do not exist in the passwd database`); return 1 }
  const caller = priv.withGroups(found)

  if (options.kill) { forget(uid); if (!options.validate && options.command.length === 0 && !options.list) return 0 }

  const targetEntry = priv.lookup(options.user)
  if (!targetEntry) { priv.err(`unknown user ${options.user}`); return 1 }
  const target = priv.withGroups(targetEntry)

  const policyText = priv.readFile('/etc/sudoers')
  if (policyText === undefined) { priv.err('/etc/sudoers: no such file, so nobody may use sudo'); return 1 }
  const policy = parseSudoers(policyText)
  for (const warning of policy.warnings) priv.err(`/etc/sudoers: ${warning}`)
  const host = (priv.readFile('/etc/hostname') ?? 'localhost').trim()
  const who = { user: caller.name, uid, groups: caller.groupNames, gids: caller.gids, host }

  if (options.list) {
    const lines = listPrivileges(policy, who)
    if (uid !== 0 && lines.length === 0) { priv.out(`User ${caller.name} is not allowed to run sudo on ${host}.\n`); return 1 }
    priv.out(`User ${caller.name} may run the following commands on ${host}:\n${lines.join('\n')}\n`)
    return 0
  }

  // what to run: the command as typed, or a shell
  const wantsShell = options.login || options.shell
  let program, programArgv
  if (wantsShell) {
    program = priv.shellFor(target)
    const shellName = program.slice(program.lastIndexOf('/') + 1)
    programArgv = options.command.length > 0 ? [shellName, '-c', options.command.join(' ')] : [options.login ? `-${shellName}` : shellName]
  } else if (options.command.length > 0) {
    program = priv.findProgram(options.command[0])
    if (!program) { priv.err(`${options.command[0]}: command not found`); return 1 }
    programArgv = options.command
  } else if (options.validate) {
    program = undefined
  } else {
    priv.out(usage + '\n')
    return 1
  }

  const request = { ...who, runAs: target.name, command: program ?? '', args: wantsShell ? programArgv.slice(1) : options.command.slice(1) }
  let decision = checkSudo(policy, request)
  if (options.validate && !program) decision = { allowed: listPrivileges(policy, who).length > 0, noPassword: decision.noPassword }
  if (!decision.allowed && uid !== 0) {
    const anyRule = listPrivileges(policy, who).length > 0
    priv.err(anyRule ? `user ${caller.name} is not allowed to run '${[program, ...request.args].join(' ')}' as ${target.name} on ${host}` : `${caller.name} is not in the sudoers file`)
    return 1
  }
  // root is never asked; others are, unless the rule says not to or they were asked a moment ago
  if (uid !== 0 && !decision.noPassword && !remembered(uid, policy.defaults.timestampTimeout)) {
    if (options.noninteractive) { priv.err('a password is required'); return 1 }
    let accepted = false
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      const password = priv.askPassword(`[sudo] password for ${caller.name}: `, options.stdin)
      if (password === null) return 1
      accepted = await priv.authenticate(caller.name, password)
      if (!accepted) { await priv.pause(1000); if (attempt < 2) priv.err('Sorry, try again.') }
    }
    if (!accepted) { priv.err('3 incorrect password attempts'); return 1 }
  }
  if (uid !== 0) remember(uid)
  if (!program) return 0

  const childEnv = options.login ? { TERM: env.TERM ?? 'xterm', PATH: env.PATH ?? '/bin:/usr/bin' } : { ...env }
  childEnv.SUDO_USER = caller.name
  childEnv.SUDO_UID = String(uid)
  childEnv.SUDO_GID = String(caller.gid)
  childEnv.SUDO_COMMAND = [program, ...request.args].join(' ')
  childEnv.HOME = target.home
  childEnv.USER = target.name
  childEnv.LOGNAME = target.name
  if (wantsShell) childEnv.SHELL = program
  return await priv.runAs(target, program, programArgv, { cwd: options.login ? target.home : getcwd(), env: childEnv })
}

try {
  exit(await main())
} catch (error) {
  priv.err(error?.message ?? String(error))
  exit(1)
}
