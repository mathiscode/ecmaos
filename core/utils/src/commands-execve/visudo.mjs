/**
 * Edits `/etc/sudoers` safely: `visudo`, or `visudo -c` to check. Edits a copy at `/etc/sudoers.tmp` (with
 * `$SUDO_EDITOR`, `$VISUAL`, `$EDITOR` or `vim`), checks it with `sudo`'s parser and installs it (mode 0440) only if
 * sound. A rule `sudo` does not understand is an error; a valid but unsupported construct (`NOEXEC:`) is noted. What
 * the file includes (`@includedir /etc/sudoers.d`) is checked with it, as `sudo` reads it.
 */

import { readSudoers } from '../lib/sudoers.ts'
import { readFileBytes, writeFileBytes } from './lib/bytes.mjs'
import { findProgram, run } from './lib/run.mjs'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, writeAll, getuid, stat, unlink, chmod, read, readdir, isDirectory } = sys

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text))

const usage = `Usage: visudo [-chqs] [-f FILE]
Edit the sudoers file, checking it before it is put in place.

  -c, --check       check the file and exit; do not edit
  -f, --file=FILE   the file to edit (default /etc/sudoers)
  -q, --quiet       with -c, print nothing when the file is fine
  -s, --strict      treat the constructs that are not supported as errors too
  -h, --help        display this help and exit

When the edited file has errors visudo asks what to do: e to edit it again, x to leave without saving, or Q to
save it anyway.`

const isNotice = message => /is not supported$/.test(message)

/**
 * The problems in `file` and what it includes, `text` standing for `file` itself (the copy being edited): `{ errors,
 * notices, files }`, each message `FILE: line N: message`.
 */
function check(file, text) {
  const io = {
    readFile: path => {
      if (path === file) return text
      try { return isDirectory(path) ? undefined : new TextDecoder().decode(readFileBytes(path)) } catch { return undefined }
    },
    readdir: path => { try { return isDirectory(path) ? readdir(path) : undefined } catch { return undefined } },
    stat: path => { try { const stats = stat(path); return { uid: Number(stats.uid), mode: Number(stats.mode) } } catch { return undefined } }
  }
  const policy = readSudoers(file, io)
  return { errors: policy.warnings.filter(message => !isNotice(message)), notices: policy.warnings.filter(isNotice), files: policy.files ?? [file] }
}

function readLine() {
  const bytes = []
  const one = new Uint8Array(1)
  for (;;) {
    const n = read(0, one, -1)
    if (n <= 0) return bytes.length ? new TextDecoder().decode(new Uint8Array(bytes)) : null
    if (one[0] === 10) return new TextDecoder().decode(new Uint8Array(bytes))
    bytes.push(one[0])
  }
}

const exists = path => { try { stat(path); return true } catch { return false } }

async function main() {
  let file = '/etc/sudoers'
  let checkOnly = false
  let quiet = false
  let strict = false
  const args = argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-h' || arg === '--help') { out(usage + '\n'); return 0 }
    if (arg === '-c' || arg === '--check') checkOnly = true
    else if (arg === '-q' || arg === '--quiet') quiet = true
    else if (arg === '-s' || arg === '--strict') strict = true
    else if (arg === '-f' || arg === '--file') file = args[++i] ?? ''
    else if (arg.startsWith('--file=')) file = arg.slice(7)
    else if (/^-f./.test(arg)) file = arg.slice(2)
    else { err(`visudo: invalid option -- '${arg.replace(/^-+/, '')}'\n${usage}\n`); return 1 }
  }
  if (!file) { err('visudo: option requires an argument -- f\n'); return 1 }
  if (getuid() !== 0) { err('visudo: you must be root to edit the sudoers file\n'); return 1 }

  const report = result => {
    for (const message of result.errors) {
      const line = /^(.+?): line (\d+): (.*)$/.exec(message)
      err(line ? `visudo: >>> ${line[1]}: syntax error near line ${line[2]} <<<\nvisudo: ${message}\n` : `visudo: >>> ${message} <<<\n`)
    }
    for (const message of result.notices) err(`visudo: ${message}\n`)
  }
  const bad = result => result.errors.length > 0 || (strict && result.notices.length > 0)

  if (checkOnly) {
    let text
    try { text = new TextDecoder().decode(readFileBytes(file)) } catch (error) { err(`visudo: unable to open ${file}: ${error?.message ?? error}\n`); return 1 }
    const result = check(file, text)
    report(result)
    if (bad(result)) return 1
    if (!quiet) for (const name of result.files) out(`${name}: parsed OK\n`)
    return 0
  }

  const temporary = `${file}.tmp`
  if (exists(temporary)) { err(`visudo: ${temporary} busy, try again later\n`); return 1 }
  const original = exists(file) ? readFileBytes(file) : new Uint8Array(0)
  writeFileBytes(temporary, original, 0o440)

  const editorName = [env.SUDO_EDITOR, env.VISUAL, env.EDITOR].find(Boolean) ?? 'vim'
  const editor = findProgram(editorName.split(/\s+/)[0])
  if (!editor) { unlink(temporary); err(`visudo: ${editorName}: command not found\n`); return 1 }

  try {
    for (;;) {
      const status = (await run(editor, [editorName.split('/').pop(), ...editorName.split(/\s+/).slice(1), temporary])).status
      if (status !== 0) err(`visudo: ${editorName} exited with status ${status}\n`)
      const edited = readFileBytes(temporary)
      if (edited.length === original.length && edited.every((byte, index) => byte === original[index])) {
        err(`visudo: ${file} unchanged\n`)
        return 0
      }
      const result = check(file, new TextDecoder().decode(edited))
      report(result)
      if (!bad(result)) {
        writeFileBytes(file, edited, 0o440)
        chmod(file, 0o440)
        return 0
      }
      for (;;) {
        out('What now? (e)dit again, e(x)it without saving, (Q)uit and save changes anyway (DANGER!) ')
        const answer = readLine()
        if (answer === null || answer === 'x') { err('visudo: no changes made\n'); return 1 }
        if (answer === 'Q') { writeFileBytes(file, edited, 0o440); chmod(file, 0o440); return 0 }
        if (answer === 'e') break
        out('Options are:\n  (e)dit sudoers file again\n  e(x)it without saving changes to sudoers file\n  (Q)uit and save changes to sudoers file (DANGER!)\n')
      }
    }
  } finally {
    try { unlink(temporary) } catch { /* already gone */ }
  }
}

try {
  exit(await main())
} catch (error) {
  err(`visudo: ${error?.message ?? String(error)}\n`)
  exit(1)
}
