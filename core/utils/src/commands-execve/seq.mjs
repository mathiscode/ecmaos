/**
 * Real `execve`'d `seq` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/seq.ts`) per `feat/1.0.0-execve-commands`. Pure computation, no file I/O
 * at all -- the simplest kind of migration.
 */

const { argv, exit, write } = globalThis.ecmaosSyscalls

const usage = `Usage: seq [OPTION]... LAST
       seq [OPTION]... FIRST LAST
       seq [OPTION]... FIRST INCREMENT LAST
Print numbers from FIRST to LAST, in steps of INCREMENT.

  -s, --separator=STRING   use STRING to separate numbers (default: \\n)
  --help                    display this help and exit`

function main() {
  const argsIn = argv.slice(1)
  if (argsIn.length > 0 && (argsIn[0] === '--help' || argsIn[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let separator = '\n'
  const args = []

  for (let i = 0; i < argsIn.length; i++) {
    const arg = argsIn[i]
    if (arg === '-s' || arg === '--separator') {
      if (i + 1 < argsIn.length) separator = argsIn[++i]
      else { write(2, new TextEncoder().encode("seq: option requires an argument -- 's'\n")); return 1 }
    } else if (arg.startsWith('--separator=')) {
      separator = arg.slice(12)
    } else if (arg.startsWith('-s')) {
      separator = arg.slice(2)
    } else if (!arg.startsWith('-')) {
      args.push(arg)
    }
  }

  if (args.length === 0) {
    write(2, new TextEncoder().encode('seq: missing operand\n'))
    return 1
  }

  let first = 1
  let increment = 1
  let last

  if (args.length === 1) {
    last = parseFloat(args[0])
    if (isNaN(last)) { write(2, new TextEncoder().encode(`seq: invalid number: ${args[0]}\n`)); return 1 }
  } else if (args.length === 2) {
    first = parseFloat(args[0])
    last = parseFloat(args[1])
    if (isNaN(first) || isNaN(last)) { write(2, new TextEncoder().encode('seq: invalid number\n')); return 1 }
  } else if (args.length === 3) {
    first = parseFloat(args[0])
    increment = parseFloat(args[1])
    last = parseFloat(args[2])
    if (isNaN(first) || isNaN(increment) || isNaN(last)) { write(2, new TextEncoder().encode('seq: invalid number\n')); return 1 }
  } else {
    write(2, new TextEncoder().encode('seq: too many arguments\n'))
    return 1
  }

  const numbers = []

  if (increment > 0) {
    for (let i = first; i <= last; i += increment) numbers.push(i)
  } else if (increment < 0) {
    for (let i = first; i >= last; i += increment) numbers.push(i)
  } else {
    write(2, new TextEncoder().encode('seq: zero increment\n'))
    return 1
  }

  const output = numbers.map(n => Number.isInteger(n) ? n.toString() : n.toFixed(10).replace(/\.?0+$/, '')).join(separator)
  write(1, new TextEncoder().encode(output + (separator === '\n' ? '' : '\n')))

  return 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`seq: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
