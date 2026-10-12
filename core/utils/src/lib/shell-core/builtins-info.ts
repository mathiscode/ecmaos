/**
 * `help`, `hash`, `times` and `logout`: the builtins that report on the shell rather than change what
 * runs. `hash` and `times` report what the system under the shell lacks: there is no command
 * location cache (every lookup walks `$PATH`) and no CPU accounting in a browser.
 */

import type { BuiltinHost, BuiltinIO } from './builtins.js'
import { helpOverview, helpTopic, matchHelpTopics } from './help.js'

export async function helpBuiltin(_host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  let description = false
  let synopsis = false
  const patterns: string[] = []
  for (const arg of argv) {
    if (arg === '--help') { await io.writeln('Usage: help [-dms] [PATTERN ...]\nDisplay information about builtin commands.\n\n  -d  output a short description for each topic\n  -m  display usage in pseudo-manpage format\n  -s  output only a short usage synopsis for each topic'); return 0 }
    if (arg === '--') continue
    if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) {
        if (letter === 'd') description = true
        else if (letter === 's') synopsis = true
        else if (letter === 'm') { /* the manpage layout is the default layout here */ }
        else { await io.writelnErr(`help: -${letter}: invalid option\nhelp: usage: help [-dms] [pattern ...]`); return 2 }
      }
      continue
    }
    patterns.push(arg)
  }

  if (patterns.length === 0) {
    await io.write('ecmaos shell builtins. These shell commands are defined internally.\nType `help\' to see this list.\nType `help NAME\' to find out more about the builtin named `NAME\'.\nUse `man -k\' or `man COMMAND\' for other commands.\n\n')
    await io.write(helpOverview())
    return 0
  }

  let status = 0
  for (const pattern of patterns) {
    const names = matchHelpTopics(pattern)
    if (names.length === 0) {
      await io.writelnErr(`help: no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}'.`)
      status = 1
      continue
    }
    for (const name of names) {
      const topic = helpTopic(name)
      if (!topic) continue
      if (description) await io.writeln(`${name} - ${topic.summary}`)
      else if (synopsis) await io.writeln(`${name}: ${topic.synopsis}`)
      else await io.write(`${name}: ${topic.synopsis}\n    ${topic.summary}\n\n`)
    }
  }
  return status
}

export async function hashBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  const usage = 'hash: usage: hash [-lr] [-p pathname] [-dt] [name ...]'
  let forget = false
  let report = false
  let listing = false
  const names: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--help') { await io.writeln('Usage: hash [-lr] [-p PATHNAME] [-dt] [NAME ...]\nRemember or display program locations.\n\n  -d  forget the remembered location of each NAME\n  -l  display in a form that may be reused as input\n  -r  forget all remembered locations\n  -t  print the location of each NAME\n\nThis shell looks every command up in $PATH each time, so nothing is remembered:\nhash checks that each NAME can be found and -p is refused.'); return 0 }
    if (arg === '--') { names.push(...argv.slice(i + 1)); break }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) {
        if (letter === 'r') { /* nothing is remembered, so there is nothing to forget */ }
        else if (letter === 'd') forget = true
        else if (letter === 't') report = true
        else if (letter === 'l') listing = true
        else if (letter === 'p') { await io.writelnErr('hash: -p: not supported: commands are looked up in $PATH each time, so a location cannot be pinned'); return 1 }
        else { await io.writelnErr(`hash: -${letter}: invalid option\n${usage}`); return 2 }
      }
      continue
    }
    names.push(arg)
  }

  if (names.length === 0) {
    if (argv.some(arg => /^-[^-]*r/.test(arg)) || listing) return 0
    await io.writeln('hash: hash table empty')
    return 0
  }

  let status = 0
  for (const name of names) {
    // A name is remembered only when it resolves to a file; forgetting is a miss because nothing was ever remembered.
    const found = await host.describe(name)
    if (forget) { await io.writelnErr(`hash: ${name}: not found`); status = 1; continue }
    if (!found || (report && found.kind !== 'file')) { await io.writelnErr(`hash: ${name}: not found`); status = 1; continue }
    if (report) await io.writeln(found.path as string)
  }
  return status
}

export async function timesBuiltin(_host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: times\nDisplay the accumulated user and system times of the shell and its children.\n\nNot available here: a browser keeps no CPU accounting, and wall-clock numbers would mislead.')
    return 0
  }
  await io.writelnErr('times: not available: there is no CPU time accounting')
  return 1
}

export async function logoutBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  if (argv[0] === '--help') {
    await io.writeln('Usage: logout [N]\nExit a login shell with status N (default: the status of the last command).')
    return 0
  }
  if (!(host.isLoginShell?.() ?? false)) {
    await io.writelnErr('logout: not login shell: use `exit\'')
    return 1
  }
  const code = argv[0] === undefined ? host.getStatus() : Number(argv[0])
  if (argv[0] !== undefined && !Number.isInteger(code)) { await io.writelnErr(`logout: ${argv[0]}: numeric argument required`); return 2 }
  return await host.interpreter.host.exitShell(code & 0xff)
}
