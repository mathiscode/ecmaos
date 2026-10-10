/**
 * `pushd`, `popd` and `dirs`. The stack lives in {@link ShellState.dirStack} (the entries below the
 * working directory), and `DIRSTACK` reads it with the working directory in front, as in bash.
 */

import type { BuiltinHost, BuiltinIO } from './builtins.js'

/** The stack as bash numbers it: the working directory is 0, then the top of the stack. */
function fullStack(host: BuiltinHost): string[] {
  return [host.cwd(), ...host.state.dirStack]
}

/** `~` for the home directory, which is how bash prints the stack unless `-l` asks for full paths. */
function abbreviate(host: BuiltinHost, path: string, long: boolean): string {
  const home = host.state.lookup('HOME')
  if (long || !home || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Changes directory the way `cd` does, keeping `PWD` and `OLDPWD`. Returns an error message on failure. */
async function goto(host: BuiltinHost, directory: string): Promise<string | undefined> {
  const before = host.cwd()
  const failure = await host.chdir(host.resolvePath(host.expandTilde ? host.expandTilde(directory) : directory))
  if (failure !== undefined) return failure
  host.state.set('OLDPWD', before)
  host.state.set('PWD', host.cwd())
  host.changed?.()
  return undefined
}

/** `+N` or `-N` as an index into a stack of `length` entries, or undefined when it is not one or out of range. */
function stackIndex(word: string, length: number): number | undefined {
  const match = /^([+-])(\d+)$/.exec(word)
  if (!match) return undefined
  const n = Number(match[2])
  if (n >= length) return undefined
  return match[1] === '+' ? n : length - 1 - n
}

const isStackArgument = (word: string) => /^[+-]\d+$/.test(word)

async function printStack(host: BuiltinHost, io: BuiltinIO): Promise<void> {
  await io.writeln(fullStack(host).map(path => abbreviate(host, path, false)).join(' '))
}

export async function dirsBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  let clear = false
  let long = false
  let perLine = false
  let numbered = false
  let index: string | undefined
  for (const arg of argv) {
    if (arg === '--help') {
      await io.writeln('Usage: dirs [-clpv] [+N] [-N]\nDisplay the directory stack.\n\n  -c  clear the stack\n  -l  print full paths, not ~\n  -p  one entry per line\n  -v  one entry per line with its index\n  +N  the Nth entry from the left, counting from zero\n  -N  the Nth entry from the right')
      return 0
    }
    if (isStackArgument(arg)) { index = arg; continue }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) {
        if (letter === 'c') clear = true
        else if (letter === 'l') long = true
        else if (letter === 'p') perLine = true
        else if (letter === 'v') { perLine = true; numbered = true }
        else { await io.writelnErr(`dirs: -${letter}: invalid option\nUsage: dirs [-clpv] [+N] [-N]`); return 2 }
      }
      continue
    }
    await io.writelnErr(`dirs: ${arg}: invalid argument`)
    return 1
  }

  if (clear) { host.state.dirStack = []; return 0 }

  const stack = fullStack(host)
  if (index !== undefined) {
    const at = stackIndex(index, stack.length)
    if (at === undefined) { await io.writelnErr(`dirs: ${index.slice(1)}: directory stack index out of range`); return 1 }
    await io.writeln(abbreviate(host, stack[at] as string, long))
    return 0
  }

  const shown = stack.map(path => abbreviate(host, path, long))
  if (numbered) await io.write(shown.map((path, i) => `${String(i).padStart(2)}  ${path}\n`).join(''))
  else if (perLine) await io.write(shown.map(path => `${path}\n`).join(''))
  else await io.writeln(shown.join(' '))
  return 0
}

export async function pushdBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  let quiet = false
  const operands: string[] = []
  for (const arg of argv) {
    if (arg === '--help') {
      await io.writeln('Usage: pushd [-n] [+N | -N | DIRECTORY]\nAdd a directory to the top of the stack, or rotate the stack.\n\n  -n         do not change directory, only the stack\n  DIRECTORY  make it the working directory and push the old one\n  +N, -N     rotate so the Nth entry (from the left, from the right) is on top\n\nWithout arguments, exchange the top two entries.')
      return 0
    }
    if (arg === '-n') { quiet = true; continue }
    if (arg === '--') continue
    if (arg.startsWith('-') && arg.length > 1 && !isStackArgument(arg)) { await io.writelnErr(`pushd: ${arg}: invalid option\nUsage: pushd [-n] [+N | -N | DIRECTORY]`); return 2 }
    operands.push(arg)
  }
  if (operands.length > 1) { await io.writelnErr('pushd: too many arguments'); return 1 }

  const state = host.state
  const operand = operands[0]
  if (operand === undefined) {
    if (state.dirStack.length === 0) { await io.writelnErr('pushd: no other directory'); return 1 }
    const stack = fullStack(host)
    ;[stack[0], stack[1]] = [stack[1] as string, stack[0] as string]
    if (!quiet) {
      const failure = await goto(host, stack[0] as string)
      if (failure !== undefined) { await io.writelnErr(`pushd: ${stack[0]}: ${failure}`); return 1 }
    }
    state.dirStack = stack.slice(1)
  } else if (isStackArgument(operand)) {
    const stack = fullStack(host)
    const at = stackIndex(operand, stack.length)
    if (at === undefined) { await io.writelnErr(`pushd: ${operand}: directory stack index out of range`); return 1 }
    const rotated = [...stack.slice(at), ...stack.slice(0, at)]
    if (!quiet) {
      const failure = await goto(host, rotated[0] as string)
      if (failure !== undefined) { await io.writelnErr(`pushd: ${rotated[0]}: ${failure}`); return 1 }
    }
    state.dirStack = rotated.slice(1)
  } else if (quiet) {
    // bash adds the directory just below the working one without checking that it exists.
    state.dirStack = [host.resolvePath(host.expandTilde ? host.expandTilde(operand) : operand), ...state.dirStack]
  } else {
    const before = host.cwd()
    const failure = await goto(host, operand)
    if (failure !== undefined) { await io.writelnErr(`pushd: ${operand}: ${failure}`); return 1 }
    state.dirStack = [before, ...state.dirStack]
  }

  await printStack(host, io)
  return 0
}

export async function popdBuiltin(host: BuiltinHost, argv: string[], io: BuiltinIO): Promise<number> {
  let quiet = false
  const operands: string[] = []
  for (const arg of argv) {
    if (arg === '--help') {
      await io.writeln('Usage: popd [-n] [+N | -N]\nRemove an entry from the directory stack.\n\n  -n      do not change directory, only the stack\n  +N, -N  remove the Nth entry (from the left, from the right)\n\nWithout arguments, remove the top entry and change to the new top.')
      return 0
    }
    if (arg === '-n') { quiet = true; continue }
    if (arg === '--') continue
    if (arg.startsWith('-') && arg.length > 1 && !isStackArgument(arg)) { await io.writelnErr(`popd: ${arg}: invalid option\nUsage: popd [-n] [+N | -N]`); return 2 }
    operands.push(arg)
  }
  if (operands.length > 1) { await io.writelnErr('popd: too many arguments'); return 1 }

  const state = host.state
  if (state.dirStack.length === 0) { await io.writelnErr('popd: directory stack empty'); return 1 }

  const stack = fullStack(host)
  // With no operand, `-n` removes the entry below the working directory, which stays where it is.
  let at = quiet ? 1 : 0
  if (operands[0] !== undefined) {
    if (!isStackArgument(operands[0])) { await io.writelnErr(`popd: ${operands[0]}: invalid argument`); return 1 }
    const found = stackIndex(operands[0], stack.length)
    if (found === undefined) { await io.writelnErr(`popd: ${operands[0]}: directory stack index out of range`); return 1 }
    at = found
  }

  const remaining = stack.filter((_, i) => i !== at)
  if (at === 0) {
    // Removing the working directory's own entry means moving to the next one.
    if (!quiet) {
      const failure = await goto(host, remaining[0] as string)
      if (failure !== undefined) { await io.writelnErr(`popd: ${remaining[0]}: ${failure}`); return 1 }
      state.dirStack = remaining.slice(1)
    }
  } else {
    state.dirStack = remaining.slice(1)
  }

  await printStack(host, io)
  return 0
}
