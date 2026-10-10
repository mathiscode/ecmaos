/**
 * `fc`: list, edit and re-run commands from the history. Both shells append every line they run to
 * `~/.ecmash_history` before running it, so `fc` reads that file; the last entry is the `fc` line itself,
 * which bash leaves out, so it is left out here. A script or `-c` text has no history, as in bash.
 */

import type { BuiltinHost, BuiltinIO } from './builtins.js'

const USAGE = 'fc: usage: fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]'

async function historyEntries(host: BuiltinHost): Promise<string[]> {
  if (host.interpreter.host.nonInteractive?.()) return []
  const home = host.state.lookup('HOME')
  if (!home) return []
  try {
    const text = await host.readFile(`${home.replace(/\/$/, '')}/.ecmash_history`)
    const lines = text.replaceAll('\0', '').split('\n').filter(line => line.length > 0)
    return lines.slice(0, -1)
  } catch { return [] }
}

/** A history reference as an index into `entries`: a number (negative from the end) or a prefix of a command. */
function resolve(entries: string[], word: string): number | undefined {
  if (/^[+-]?\d+$/.test(word)) {
    const n = Number(word)
    const index = n < 0 ? entries.length + n : n - 1
    return index >= 0 && index < entries.length ? index : n < 0 ? 0 : entries.length - 1
  }
  for (let i = entries.length - 1; i >= 0; i--) if ((entries[i] as string).startsWith(word)) return i
  return undefined
}

export async function fcBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  let editor: string | undefined
  let list = false
  let omitNumbers = false
  let reverse = false
  let rerun = false
  const operands: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help') {
      await io.writeln('Usage: fc [-e ENAME] [-lnr] [FIRST] [LAST]\n       fc -s [PAT=REP] [COMMAND]\nList, edit or re-run commands from the history.\n\n  -l  list the commands instead of editing them\n  -n  leave the numbers out of the list\n  -r  reverse the order\n  -s  run COMMAND again after replacing PAT with REP\n  -e  edit with ENAME (default: $FCEDIT, $EDITOR, then vim); `-e -` runs the commands again at once\n\nFIRST and LAST are numbers, negative ones counting back from the last command, or the start of a command.')
      return 0
    }
    if (arg === '--') { operands.push(...argv.slice(i + 1)); break }
    if (/^-\d+$/.test(arg) || !arg.startsWith('-') || arg === '-') { operands.push(arg); continue }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j] as string
      if (letter === 'l') list = true
      else if (letter === 'n') omitNumbers = true
      else if (letter === 'r') reverse = true
      else if (letter === 's') rerun = true
      else if (letter === 'e') {
        const rest = arg.slice(j + 1)
        editor = rest !== '' ? rest : argv[++i]
        if (editor === undefined) { await io.writelnErr('fc: -e: option requires an argument'); return 2 }
        break
      } else { await io.writelnErr(`fc: -${letter}: invalid option\n${USAGE}`); return 2 }
    }
  }
  if (editor === '-') { rerun = true; editor = undefined }

  const entries = await historyEntries(host)
  if (entries.length === 0) { await io.writelnErr('fc: no command found'); return 1 }

  if (rerun) {
    let substitution: [string, string] | undefined
    let target = operands[0]
    const assignment = target === undefined ? null : /^([^=]+)=(.*)$/s.exec(target)
    if (assignment) { substitution = [assignment[1] as string, assignment[2] as string]; target = operands[1] }
    const index = target === undefined ? entries.length - 1 : resolve(entries, target)
    if (index === undefined) { await io.writelnErr('fc: no command found'); return 1 }
    let command = entries[index] as string
    if (substitution) command = command.replace(substitution[0], substitution[1])
    await io.writeln(command)
    return await host.interpreter.runText(command)
  }

  const lastIndex = entries.length - 1
  let first: number | undefined
  let last: number | undefined
  if (list) {
    first = operands[0] === undefined ? Math.max(0, entries.length - 16) : resolve(entries, operands[0])
    last = operands[1] === undefined ? lastIndex : resolve(entries, operands[1])
  } else {
    first = operands[0] === undefined ? lastIndex : resolve(entries, operands[0])
    last = operands[1] === undefined ? first : resolve(entries, operands[1])
  }
  if (first === undefined || last === undefined) { await io.writelnErr('fc: no command found'); return 1 }

  let indices: number[] = []
  const step = first <= last ? 1 : -1
  for (let i = first; step > 0 ? i <= last : i >= last; i += step) indices.push(i)
  if (reverse) indices = indices.reverse()

  if (list) {
    for (const i of indices) await io.writeln(`${omitNumbers ? '' : i + 1}\t ${entries[i]}`)
    return 0
  }

  // Editing: the commands go to a file, the editor changes it, and what comes back is shown and run.
  if (!host.writeFile || !host.removeFile) { await io.writelnErr('fc: editing is not available in this shell'); return 1 }
  const name = editor ?? host.state.lookup('FCEDIT') ?? host.state.lookup('EDITOR') ?? 'vim'
  const file = `/tmp/fc.${Math.random().toString(36).slice(2, 10)}`
  await host.writeFile(file, indices.map(i => entries[i]).join('\n') + '\n')
  let text: string
  try {
    const status = await host.runArgv([...name.split(/\s+/).filter(Boolean), file])
    if (status !== 0) { await io.writelnErr(`fc: ${name}: exited with status ${status}`); return status }
    text = await host.readFile(file)
  } finally {
    await host.removeFile(file).catch(() => {})
  }
  if (text.trim() === '') return 0
  await io.write(text.endsWith('\n') ? text : `${text}\n`)
  return await host.interpreter.runText(text)
}
