/**
 * `crontab`: install, list, edit or remove a user's table for `crond`, `/var/spool/cron/crontabs/USER` (mode 0600, owned
 * by the user). It runs with the setuid bit, as cronie's does, so the spool can be root's while `getuid()` still says who
 * asked; `-u` is root's. `/etc/cron.allow` and `/etc/cron.deny` decide who may use it, root always may. A table is
 * checked before it is installed, and one with errors is refused. `-e` edits a copy the user owns, in their editor, as
 * them.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readFdText, readTextFile } from './lib/fs-text.mjs'
import { makePriv } from './lib/priv.mjs'
import { parseCrontabLine } from './lib/crontab-lines.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, getuid, getcwd, open, close, writeAll, mkdir, chown, chmod, unlink, stat, O_WRONLY, O_CREAT, O_TRUNC } = sys
const priv = makePriv(sys, 'crontab')
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(`crontab: ${text}\n`))

const SPOOL = '/var/spool/cron/crontabs'

const usage = `Usage:
 crontab [options] file
 crontab [options]
 crontab -n [hostname]

Options:
 -u <user>  define user
 -e         edit user's crontab
 -l         list user's crontab
 -r         delete user's crontab
 -i         prompt before deleting
 -T <file>  test a crontab file syntax
 -h         print this help and exit
 -V         print version and exit

Default operation is replace, per 1003.2. A file of "-" is standard input.`

const exists = path => { try { stat(path); return true } catch { return false } }
const readOrUndefined = path => { try { return readTextFile(path) } catch { return undefined } }

/** Whether `user` may have a crontab: listed in cron.allow when it exists, else not listed in cron.deny */
function allowed(user) {
  if (user.uid === 0) return true
  const names = text => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const allow = readOrUndefined('/etc/cron.allow')
  if (allow !== undefined) return names(allow).includes(user.name)
  const deny = readOrUndefined('/etc/cron.deny')
  return deny === undefined || !names(deny).includes(user.name)
}

/** The errors in a table, as `"name":line: reason`; an environment setting (`NAME=value`) is a line cron accepts */
function check(text, label) {
  const errors = []
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) return
    if (!parseCrontabLine(trimmed)) errors.push(`"${label}":${index + 1}: bad ${trimmed.startsWith('@') ? 'time specifier' : 'entry'}: ${trimmed}`)
  })
  return errors
}

function install(user, text) {
  if (!exists(SPOOL)) {
    if (!exists('/var/spool/cron')) mkdir('/var/spool/cron', 0o755)
    mkdir(SPOOL, 0o700)
  }
  const path = `${SPOOL}/${user.name}`
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
  try { writeAll(fd, encoder.encode(text.endsWith('\n') || text === '' ? text : text + '\n')) } finally { close(fd) }
  chmod(path, 0o600)
  chown(path, user.uid, user.gid)
}

/** Asks a yes/no question on the terminal; anything but y is no */
function ask(question) {
  out(question)
  const answer = priv.readLine()
  return /^y/i.test(answer ?? '')
}

function editorFor() {
  for (const key of ['VISUAL', 'EDITOR']) {
    const words = (env[key] ?? '').trim().split(/\s+/).filter(Boolean)
    const program = words.length ? priv.findProgram(words[0]) : undefined
    if (program) return { program, args: words.slice(1) }
  }
  for (const candidate of ['vi', 'vim', 'nano', 'ed']) {
    const program = priv.findProgram(candidate)
    if (program) return { program, args: [] }
  }
  return undefined
}

async function edit(user, caller) {
  const editor = editorFor()
  if (!editor) { err('no editor found: set VISUAL or EDITOR'); return 1 }
  const current = readOrUndefined(`${SPOOL}/${user.name}`)
  const temporary = `/tmp/crontab.${Math.random().toString(36).slice(2, 8)}`
  const before = current ?? '# m h  dom mon dow   command\n'
  const fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
  try { writeAll(fd, encoder.encode(before)) } finally { close(fd) }
  chown(temporary, caller.uid, caller.gid)
  try {
    for (;;) {
      const code = await priv.runAs(caller, editor.program, [editor.program.slice(editor.program.lastIndexOf('/') + 1), ...editor.args, temporary], { cwd: getcwd(), env: { ...env } })
      if (code !== 0) { err(`"${editor.program}" exited with status ${code}`); return 1 }
      const after = readTextFile(temporary)
      if (current !== undefined && after === current) { err('no changes made to crontab'); return 0 }
      const errors = check(after, temporary)
      if (errors.length === 0) {
        err('installing new crontab')
        install(user, after)
        return 0
      }
      for (const line of errors) writeAll(2, encoder.encode(line + '\n'))
      writeAll(2, encoder.encode('errors in crontab file, can\'t install.\n'))
      if (!ask('Do you want to retry the same edit? (y/n) ')) { err('edits left in ' + temporary); return 1 }
    }
  } finally {
    try { unlink(temporary) } catch { /* gone */ }
  }
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), { short: 'u:elriT:hVn::c', long: { help: 'h', version: 'V' }, permute: false })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('crontab') + '\n')); return 1 }
  let target
  let action
  let confirm = false
  let test
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'V') { out('crontab (ecmaOS coreutils) 1.0\n'); return 0 }
    if (key === 'u') target = value
    else if (key === 'i') confirm = true
    else if (key === 'T') test = value
    else if (key === 'n' || key === 'c') { err('there is one machine: no cluster host to set or show'); return 1 }
    else {
      if (action && action !== key) { err('only one operation permitted'); return 1 }
      action = key
    }
  }

  if (test !== undefined) {
    let text
    try { text = test === '-' ? readFdText(0) : readTextFile(test) } catch (e) { err(`${test}: ${reasonOf(e)}`); return 1 }
    const errors = check(text, test)
    for (const line of errors) writeAll(2, encoder.encode(line + '\n'))
    if (errors.length) { writeAll(2, encoder.encode('Invalid crontab file.\n')); return 1 }
    return 0
  }

  const caller = priv.lookup(getuid())
  if (!caller) { err(`your UID isn't in the passwd file. bailing out.`); return 1 }
  const callerFull = priv.withGroups(caller)
  if (target !== undefined && callerFull.uid !== 0) { err('must be privileged to use -u'); return 1 }
  const found = target === undefined ? caller : priv.lookup(/^\d+$/.test(target) ? Number(target) : target)
  if (!found) { err(`user '${target}' unknown`); return 1 }
  const user = priv.withGroups(found)
  if (!allowed(callerFull)) { writeAll(2, encoder.encode(`You (${callerFull.name}) are not allowed to use this program (crontab)\nSee crontab(1) for more information\n`)); return 1 }

  const path = `${SPOOL}/${user.name}`
  if (action === 'l') {
    if (operands.length) { err('-l takes no file'); return 1 }
    const text = readOrUndefined(path)
    if (text === undefined) { writeAll(2, encoder.encode(`no crontab for ${user.name}\n`)); return 1 }
    out(text)
    return 0
  }
  if (action === 'r') {
    if (!exists(path)) { writeAll(2, encoder.encode(`no crontab for ${user.name}\n`)); return 1 }
    if (confirm && !ask(`crontab: really delete ${user.name}'s crontab? (y/n) `)) return 0
    unlink(path)
    return 0
  }
  if (action === 'e') return await edit(user, callerFull)

  if (operands.length > 1) { err('only one file may be given'); writeAll(2, encoder.encode(usage + '\n')); return 1 }
  const file = operands[0] ?? '-'
  let text
  try {
    if (file === '-') text = readFdText(0)
    else {
      // the file is read as the caller could read it, not as root: a setuid program must not disclose another's file
      const info = stat(file)
      if (callerFull.uid !== 0 && info.uid !== callerFull.uid && !(info.mode & 0o004) && !((info.mode & 0o040) && callerFull.gids.includes(info.gid))) { err(`${file}: Permission denied`); return 1 }
      text = readTextFile(file)
    }
  } catch (e) { err(`${file}: ${reasonOf(e)}`); return 1 }
  const errors = check(text, file === '-' ? '-' : file)
  if (errors.length) {
    for (const line of errors) writeAll(2, encoder.encode(line + '\n'))
    writeAll(2, encoder.encode('errors in crontab file, can\'t install.\n'))
    return 1
  }
  install(user, text)
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(error instanceof Error ? error.message : String(error))
  exit(1)
}
