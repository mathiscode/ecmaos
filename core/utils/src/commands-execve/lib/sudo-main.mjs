/**
 * `/bin/sudo [-u USER] [-i | -s] [-n] [-S] [-k | -K] [-v] [-l] [--] [COMMAND [ARG]...]`: runs a command as another
 * user (root by default) if `/etc/sudoers` allows it (grammar: `lib/sudoers.ts`). The password asked for is the
 * caller's own, remembered for `timestamp_timeout` minutes (default 5) in a per-user file in `/run/sudo/ts` (root's,
 * mode 0700). Root is never asked.
 * It has the setuid bit so it can read `/etc/sudoers` (0440) and start something as someone else while `getuid()`
 * still says who ran it.
 *
 * `sudo -e FILE...`, and `/bin/sudoedit FILE...` (the same program; `argv[0]` says which), edit files as root without
 * running the editor as root: each file is copied to a temporary file the caller owns, the caller's editor changes that,
 * and the result is copied back as root if it changed. `sudo.mjs` and `sudoedit.mjs` only load this.
 */

import { checkSudo, listPrivileges, parseSudoers } from '../../lib/sudoers.ts'
import { readFileBytes, writeFdBytes } from './bytes.mjs'
import { makePriv } from './priv.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, getcwd, getuid, mkdir, open, close, unlink, writeAll, stat, isSymbolicLink, isDirectory, chown, O_WRONLY, O_CREAT, O_TRUNC } = sys
/** `sudoedit` is this program run under that name */
const asSudoedit = (argv[0] ?? '').split('/').pop() === 'sudoedit'
const name = asSudoedit ? 'sudoedit' : 'sudo'
const priv = makePriv(sys, name)

const sudoeditUsage = `Usage: sudoedit [OPTION]... FILE...
Edit files as root with the caller's own editor: a copy is edited and copied back if it changed.

  -n  never ask for a password   -S  read the password from standard input   -h  display this help

The editor is SUDO_EDITOR, VISUAL or EDITOR, else the first of nano, vim, vi, ed found. Files in a directory the\ncaller can write to, and symbolic links, are refused.`

const usage = `Usage: sudo [OPTION]... [--] COMMAND [ARG]...
       sudo [OPTION]... -i | -s [COMMAND [ARG]...]
       sudo [OPTION]... -e FILE...      (also: sudoedit FILE...)
Run COMMAND as another user (root by default) if /etc/sudoers allows it.

  -u, --user=USER     run as USER
  -i, --login         run USER's login shell, in their home directory
  -s, --shell         run USER's shell
  -n, --non-interactive  never ask for a password; fail if one is needed
  -S, --stdin         read the password from standard input, not the terminal
  -k, -K              forget the remembered password
  -v                  remember the password without running anything
  -l, --list          list what the caller may run
  -e, --edit          edit FILEs as root, in the caller's editor (SUDO_EDITOR, VISUAL, EDITOR)
  -h, --help          display this help and exit`

const encoder = new TextEncoder()
const TIMESTAMPS = '/run/sudo/ts'

function parse(args) {
  const options = { edit: asSudoedit, user: 'root', login: false, shell: false, noninteractive: false, stdin: false, kill: false, validate: false, list: false, command: [] }
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
    else if (arg === '-e' || arg === '--edit') options.edit = true
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

/** The editor to run: SUDO_EDITOR, VISUAL or EDITOR (a program and its arguments), else the first of a few that are installed */
function editorFor(callerEnv) {
  for (const key of ['SUDO_EDITOR', 'VISUAL', 'EDITOR']) {
    const words = (callerEnv[key] ?? '').trim().split(/\s+/).filter(Boolean)
    const program = words.length ? priv.findProgram(words[0]) : undefined
    if (program) return { program, args: words.slice(1) }
  }
  for (const candidate of ['nano', 'vim', 'vi', 'ed']) {
    const program = priv.findProgram(candidate)
    if (program) return { program, args: [] }
  }
  return undefined
}

const dirOf = path => path.slice(0, path.lastIndexOf('/')) || '/'

/** Whether the caller could swap what is at the path while it is edited: they own its directory, or others can write there */
function dirIsRisky(dir, uid) {
  try {
    const info = stat(dir)
    return info.uid === uid || (info.mode & 0o022) !== 0
  } catch { return false }
}

/** `sudo -e`: each file is edited in a copy the caller owns and written back, as root, if it changed. Resolves to the exit status. */
async function editFiles(caller, files) {
  const editor = editorFor(env)
  if (!editor) { priv.err('no editor found: set SUDO_EDITOR, VISUAL or EDITOR'); return 1 }
  const uid = getuid()
  const cwd = getcwd()
  let status = 0
  for (const name of files) {
    const path = name.startsWith('/') ? name : `${cwd.replace(/\/$/, '')}/${name}`
    const dir = dirOf(path)
    // as sudo does, refuse where the caller could change which file is meant between the copy and the write-back
    if (uid !== 0 && dirIsRisky(dir, uid)) { priv.err(`${name}: editing files in a writable directory is not permitted`); status = 1; continue }
    let exists = true
    try { if (isSymbolicLink(path)) { priv.err(`${name}: editing symbolic links is not permitted`); status = 1; continue } } catch { exists = false }
    try { exists = exists && !isDirectory(path) && (stat(path), true) } catch { exists = false }
    try { if (isDirectory(path)) { priv.err(`${name}: not a regular file`); status = 1; continue } } catch { /* it is new */ }
    let before = new Uint8Array()
    if (exists) { try { before = readFileBytes(path) } catch (e) { priv.err(`${name}: ${e?.message ?? e}`); status = 1; continue } }

    const temporary = `/tmp/sudoedit.${Math.random().toString(36).slice(2, 10)}.${path.slice(path.lastIndexOf('/') + 1)}`
    try {
      const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
      try { writeFdBytes(fd, before) } finally { close(fd) }
      chown(temporary, uid, caller.gid)
    } catch (e) { priv.err(`${temporary}: ${e?.message ?? e}`); status = 1; try { unlink(temporary) } catch { /* not made */ } continue }

    try {
      const code = await priv.runAs(caller, editor.program, [editor.program.slice(editor.program.lastIndexOf('/') + 1), ...editor.args, temporary], { cwd, env: { ...env } })
      if (code !== 0) { priv.err(`${name} not updated: the editor exited with status ${code}`); status = 1; continue }
      const after = readFileBytes(temporary)
      if (exists && after.length === before.length && after.every((byte, i) => byte === before[i])) { priv.err(`${name} unchanged`); continue }
      if (!exists && after.length === 0) { priv.err(`${name} unchanged`); continue }
      const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
      try { writeFdBytes(fd, after) } finally { close(fd) }
    } catch (e) {
      priv.err(`${name}: ${e?.message ?? e}`)
      status = 1
    } finally {
      try { unlink(temporary) } catch { /* gone */ }
    }
  }
  return status
}

async function main() {
  const options = parse(argv.slice(1))
  if (options.help) { priv.out((asSudoedit ? sudoeditUsage : usage) + '\n'); return 0 }
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
  if (options.edit) {
    if (wantsShell) { priv.err('-e cannot be used with -i or -s'); return 1 }
    if (options.command.length === 0) { priv.out((asSudoedit ? sudoeditUsage : usage) + '\n'); return 1 }
    if (target.name !== 'root') { priv.err('files can only be edited as root'); return 1 }
    // the policy names it `sudoedit`, whatever the editor is
    program = 'sudoedit'
    programArgv = ['sudoedit', ...options.command]
  } else if (wantsShell) {
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

  const request = { ...who, runAs: target.name, command: program ?? '', args: wantsShell ? programArgv.slice(1) : options.edit ? options.command : options.command.slice(1) }
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
  if (options.edit) return await editFiles(caller, options.command)

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
