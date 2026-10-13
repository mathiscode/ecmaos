/** Search input for lines matching a pattern. */

import { resolve } from './lib/path-utils.mjs'
import { isTty } from './lib/tty.mjs'
import { readFileBytes } from './lib/bytes.mjs'

const { argv, env, exit, writeAll, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const usage = `Usage: grep [OPTION]... PATTERN [FILE]...
Search for PATTERN in each FILE.

  -i, --ignore-case   ignore case distinctions
  -v                  select non-matching lines
  -q                  print nothing; exit 0 if a line matched
  -F                  PATTERN is a fixed string
  -E                  PATTERN is an extended regular expression (the default)
  -n, --line-number   print line number with output lines
  -c, --count         print only a count of matching lines per FILE
  --color[=WHEN]      mark matches, file names and line numbers in color: always, auto (the default for --color) or never
  --help              display this help and exit`

function readWholeFile(fullPath) {
  const bytes = readFileBytes(fullPath)
  return bytes
}

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let ignoreCase = false
  let showLineNumbers = false
  let countOnly = false
  let invert = false
  let quiet = false
  let fixed = false
  let selected = 0
  let colorWhen = 'never'
  const positional = []

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      writeAll(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '--color' || arg === '--colour' || arg.startsWith('--color=') || arg.startsWith('--colour=')) {
      // GNU grep: `--color` alone means auto
      const when = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : 'auto'
      const mapped = { always: 'always', yes: 'always', force: 'always', never: 'never', no: 'never', none: 'never', auto: 'auto', tty: 'auto', 'if-tty': 'auto' }[when]
      if (!mapped) {
        writeAll(2, new TextEncoder().encode(`grep: invalid argument '${when}' for '--color'\n`))
        return 2
      }
      colorWhen = mapped
    } else if (arg === '-i' || arg === '--ignore-case') {
      ignoreCase = true
    } else if (arg === '-n' || arg === '--line-number') {
      showLineNumbers = true
    } else if (arg === '-c' || arg === '--count') {
      countOnly = true
    } else if (arg.startsWith('-')) {
      const flags = arg.slice(1).split('')
      if (flags.includes('i')) ignoreCase = true
      if (flags.includes('n')) showLineNumbers = true
      if (flags.includes('c')) countOnly = true
      if (flags.includes('v')) invert = true
      if (flags.includes('q')) quiet = true
      if (flags.includes('F')) fixed = true
      // -E is the default: the pattern is a JavaScript regular expression, which is extended syntax.
      const invalid = flags.find(f => !['i', 'n', 'c', 'v', 'q', 'F', 'E', 'G'].includes(f))
      if (invalid) {
        writeAll(2, new TextEncoder().encode(`grep: invalid option -- '${invalid}'\n`))
        return 1
      }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) {
    writeAll(2, new TextEncoder().encode('grep: pattern is required\n'))
    return 1
  }

  const pattern = positional[0]
  const files = positional.slice(1)

  let regex
  try {
    regex = new RegExp(fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, ignoreCase ? 'i' : '')
  } catch (error) {
    writeAll(2, new TextEncoder().encode(`grep: invalid pattern: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }

  // Colors: the match is bold red, the file name magenta, the line number green and the separators cyan,
  // as in GNU grep's defaults. `$GREP_COLORS` can change `ms`, `fn`, `ln` and `se`.
  const useColor = colorWhen === 'always' || (colorWhen === 'auto' && isTty(1) && env?.TERM !== 'dumb')
  const palette = { ms: '01;31', fn: '35', ln: '32', se: '36' }
  if (useColor) for (const part of (env?.GREP_COLORS ?? '').split(':')) { const [key, value] = part.split('='); if (key in palette && value) palette[key] = value }
  const sgr = (codes, text) => `\x1b[${codes}m\x1b[K${text}\x1b[m\x1b[K`
  const highlighter = useColor && !invert ? new RegExp(regex.source, regex.flags + 'g') : undefined
  const body = line => {
    if (!highlighter) return line
    let result = ''
    let last = 0
    for (const match of line.matchAll(highlighter)) {
      if (match[0] === '') continue
      result += line.slice(last, match.index) + sgr(palette.ms, match[0])
      last = match.index + match[0].length
    }
    return result + line.slice(last)
  }
  const label = (file, number) => {
    if (!useColor) return `${file ? `${file}:` : ''}${number ? `${number}:` : ''}`
    return `${file ? sgr(palette.fn, file) + sgr(palette.se, ':') : ''}${number ? sgr(palette.ln, number) + sgr(palette.se, ':') : ''}`
  }
  let output = ''
  let exitCode = 0

  if (files.length === 0) {
    const content = new TextDecoder().decode(readAllStdin())
    const lines = content.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    let lineNumber = 1
    let count = 0
    for (const line of lines) {
      if (regex.test(line) !== invert) {
        count++
        selected++
        if (!countOnly) output += `${label('', showLineNumbers ? lineNumber : '')}${body(line)}\n`
      }
      lineNumber++
    }
    if (countOnly) output = `${count}\n`
  } else {
    const cwd = getcwd()
    for (const file of files) {
      const fullPath = resolve(cwd, file)
      try {
        const content = new TextDecoder().decode(readWholeFile(fullPath))
        const lines = content.split('\n')
        if (lines[lines.length - 1] === '') lines.pop()

        let lineNumber = 1
        let count = 0
        for (const line of lines) {
          if (regex.test(line) !== invert) {
            count++
            selected++
            if (!countOnly) output += `${label(files.length > 1 ? file : '', showLineNumbers ? lineNumber : '')}${body(line)}\n`
          }
          lineNumber++
        }
        if (countOnly) output += `${label(files.length > 1 ? file : '', '')}${count}\n`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeAll(2, new TextEncoder().encode(`grep: ${file}: ${message}\n`))
        exitCode = 1
      }
    }
  }

  if (!quiet) writeAll(1, new TextEncoder().encode(output))
  // GNU grep: 0 when a line was selected, 1 when none was, 2 on error.
  return exitCode !== 0 ? 2 : selected > 0 ? 0 : 1
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`grep: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
