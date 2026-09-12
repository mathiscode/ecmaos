/**
 * Real `execve`'d `chmod` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/chmod.ts`) per `feat/1.0.0-execve-commands`. Symbolic-mode parsing
 * (`u+x`, `g-w`, ...) is unchanged business logic, just re-hosted against real syscalls.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, getcwd, stat, chmod } = globalThis.ecmaosSyscalls

const usage = `Usage: chmod [OPTION]... MODE[,MODE]... FILE...
   or:  chmod [OPTION]... OCTAL-MODE FILE...
Change the mode of each FILE to MODE.`

function parseNumericMode(mode) {
  if (/^0?[0-7]{1,4}$/.test(mode)) return parseInt(mode, 8)
  if (/^0o[0-7]{1,4}$/i.test(mode)) return parseInt(mode.slice(2), 8)
  return null
}

function parseSymbolicMode(mode, currentMode) {
  const parts = mode.split(',')
  let newMode = currentMode

  for (const part of parts) {
    const match = part.match(/^([ugoa]*)([+\-=])([rwxXst]*)$/)
    if (!match) throw new Error(`Invalid mode: ${part}`)

    const [, who, op, perms = ''] = match
    const whoSet = who || 'a'
    if ((op === '+' || op === '-') && !perms) throw new Error(`Invalid mode: ${part} (missing permissions)`)

    const userBits = 0o400 | 0o200 | 0o100
    const groupBits = 0o040 | 0o020 | 0o010
    const otherBits = 0o004 | 0o002 | 0o001

    let permBits = 0
    if (perms.includes('r')) permBits |= 0o444
    if (perms.includes('w')) permBits |= 0o222
    if (perms.includes('x')) permBits |= 0o111
    if (perms.includes('X') && (currentMode & 0o111)) permBits |= 0o111
    if (perms.includes('s')) permBits |= 0o6000
    if (perms.includes('t')) permBits |= 0o1000

    let targetBits = 0
    if (whoSet.includes('u') || whoSet.includes('a')) targetBits |= userBits
    if (whoSet.includes('g') || whoSet.includes('a')) targetBits |= groupBits
    if (whoSet.includes('o') || whoSet.includes('a')) targetBits |= otherBits

    if (op === '+') newMode |= (permBits & targetBits)
    else if (op === '-') newMode &= ~(permBits & targetBits)
    else { newMode &= ~targetBits; newMode |= (permBits & targetBits) }
  }

  return newMode
}

function parseMode(mode, filePath) {
  const numeric = parseNumericMode(mode)
  if (numeric !== null) return numeric
  const currentMode = stat(filePath).mode & 0o7777
  return parseSymbolicMode(mode, currentMode)
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const positional = args.filter(arg => arg && !arg.startsWith('-'))
  if (positional.length === 0) {
    write(2, new TextEncoder().encode("chmod: missing operand\nTry 'chmod --help' for more information.\n"))
    return 1
  }

  const [mode, ...targets] = positional
  if (!mode || targets.length === 0) {
    write(2, new TextEncoder().encode("chmod: missing operand\nTry 'chmod --help' for more information.\n"))
    return 1
  }

  const cwd = getcwd()
  let hasError = false

  for (const target of targets) {
    const fullPath = resolve(cwd, target)
    try {
      chmod(fullPath, parseMode(mode, fullPath))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`chmod: ${target}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`chmod: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
