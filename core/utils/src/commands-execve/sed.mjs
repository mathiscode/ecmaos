/**
 * Real `execve`'d `sed` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/sed.ts`) per `feat/1.0.0-execve-commands`. `shell.expandTilde(...)` is
 * replaced by the same small worker-local `~`/`~/rest` expansion `tee.mjs` uses (see its doc
 * comment). See `cat.mjs`'s doc comment for why there's no in-band interrupt handling anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, env, open, close, stat, isDirectory, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...

Stream editor for filtering and transforming text.

  -e, --expression=script  add the script to the commands to be executed
  -f, --file=script-file    add the contents of script-file to the commands
  -i[SUFFIX], --in-place[=SUFFIX]  edit files in place (makes backup if SUFFIX supplied)
  -q, --quiet               suppress normal output
  --help                    display this help and exit`

function expandTilde(input) {
  const home = env.HOME
  if (!home) return input
  if (input === '~') return home
  if (input.startsWith('~/')) return home + input.slice(1)
  return input
}

function readWholeFile(fullPath) {
  const size = stat(fullPath).size
  const fd = open(fullPath, O_RDONLY)
  const bytes = new Uint8Array(size)
  try {
    let bytesRead = 0
    while (bytesRead < size) {
      const chunk = new Uint8Array(size - bytesRead)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), bytesRead)
      bytesRead += n
    }
  } finally {
    close(fd)
  }
  return bytes
}

function writeWholeFile(fullPath, bytes) {
  const fd = open(fullPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    write(fd, bytes)
  } finally {
    close(fd)
  }
}

function exists(fullPath) {
  try { stat(fullPath); return true } catch { return false }
}

function readAllStdin() {
  const chunkSize = 65536
  const chunks = []
  while (true) {
    const buffer = new Uint8Array(chunkSize)
    const n = read(0, buffer, -1)
    if (n <= 0) break
    chunks.push(buffer.subarray(0, n))
    if (n < chunkSize) break
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

function parseSedExpression(expr) {
  expr = expr.trim()

  const substituteMatch = expr.match(/^(\d+)?(,(\d+|\$))?s\/(.+?)\/(.*?)\/([gip]*\d*)$/)
  if (substituteMatch) {
    const [, startLine, , endLine, pattern, replacement, flags] = substituteMatch
    const address = startLine ? {
      type: endLine ? 'range' : 'line',
      start: parseInt(startLine, 10),
      ...(endLine && { end: endLine === '$' ? Infinity : parseInt(endLine, 10) })
    } : undefined

    return {
      type: 'substitute',
      pattern,
      replacement: replacement || '',
      flags: flags || '',
      address
    }
  }

  const simpleSubstituteMatch = expr.match(/^s\/(.+?)\/(.*?)\/([gip]*\d*)$/)
  if (simpleSubstituteMatch) {
    const [, pattern, replacement, flags] = simpleSubstituteMatch
    return {
      type: 'substitute',
      pattern,
      replacement: replacement || '',
      flags: flags || ''
    }
  }

  const deleteMatch = expr.match(/^(\d+)?(,(\d+|\$))?d$/)
  if (deleteMatch) {
    const [, startLine, , endLine] = deleteMatch
    const address = startLine ? {
      type: endLine ? 'range' : 'line',
      start: parseInt(startLine, 10),
      ...(endLine && { end: endLine === '$' ? Infinity : parseInt(endLine, 10) })
    } : undefined

    return { type: 'delete', address }
  }

  const patternDeleteMatch = expr.match(/^\/(.+?)\/d$/)
  if (patternDeleteMatch) {
    return { type: 'delete', address: { type: 'pattern', start: patternDeleteMatch[1] } }
  }

  const printMatch = expr.match(/^\/(.+?)\/p$/)
  if (printMatch) {
    return { type: 'print', address: { type: 'pattern', start: printMatch[1] } }
  }

  return null
}

function applySedCommand(line, lineNum, totalLines, command) {
  if (command.type === 'substitute') {
    if (!command.pattern || command.replacement === undefined) {
      return { result: line, shouldPrint: false }
    }

    let shouldApply = true

    if (command.address) {
      switch (command.address.type) {
        case 'line':
          shouldApply = lineNum === command.address.start
          break
        case 'range': {
          const end = command.address.end === Infinity ? totalLines : command.address.end
          shouldApply = lineNum >= command.address.start && lineNum <= end
          break
        }
        case 'pattern':
          try {
            shouldApply = new RegExp(command.address.start).test(line)
          } catch {
            return { result: line, shouldPrint: false }
          }
          break
      }
    }

    if (!shouldApply) return { result: line, shouldPrint: false }

    const flags = command.flags || ''
    const global = flags.includes('g')
    const caseInsensitive = flags.includes('i')
    const nthMatch = flags.match(/^\d+$/) ? parseInt(flags, 10) : null

    try {
      let regexFlags = global ? 'g' : ''
      if (caseInsensitive) regexFlags += 'i'

      if (nthMatch) {
        let count = 0
        const regex = new RegExp(command.pattern, caseInsensitive ? 'gi' : 'g')
        const result = line.replace(regex, (match) => {
          count++
          return count === nthMatch ? (command.replacement || match) : match
        })
        return { result, shouldPrint: false }
      }

      const regex = new RegExp(command.pattern, regexFlags || undefined)
      const result = line.replace(regex, command.replacement)
      return { result, shouldPrint: false }
    } catch {
      return { result: line, shouldPrint: false }
    }
  }

  if (command.type === 'delete') {
    if (command.address) {
      switch (command.address.type) {
        case 'line':
          if (lineNum === command.address.start) return { result: null, shouldPrint: false }
          break
        case 'range': {
          const end = command.address.end === Infinity ? totalLines : command.address.end
          if (lineNum >= command.address.start && lineNum <= end) return { result: null, shouldPrint: false }
          break
        }
        case 'pattern':
          try {
            if (new RegExp(command.address.start).test(line)) return { result: null, shouldPrint: false }
          } catch {
            return { result: line, shouldPrint: false }
          }
          break
      }
    }
    return { result: line, shouldPrint: false }
  }

  if (command.type === 'print') {
    if (command.address && command.address.type === 'pattern') {
      try {
        if (new RegExp(command.address.start).test(line)) return { result: line, shouldPrint: true }
      } catch {
        return { result: line, shouldPrint: false }
      }
    }
    return { result: line, shouldPrint: false }
  }

  return { result: line, shouldPrint: false }
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const expressions = []
  const files = []
  let scriptFile
  let inplace
  let quiet = false

  const isSedExpression = (arg) => {
    if (!arg) return false
    const trimmed = arg.trim()
    return (
      trimmed.startsWith('s/') ||
      /^\/.+?\/[dp]$/.test(trimmed) ||
      /^\d+[sd]$/.test(trimmed) ||
      /^\d+,\d*[sd]$/.test(trimmed) ||
      /^\d+s\//.test(trimmed) ||
      /^\d+,\d*s\//.test(trimmed)
    )
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      write(2, new TextEncoder().encode(usage + '\n'))
      return 0
    } else if (arg === '-e' || arg === '--expression') {
      if (i + 1 < args.length) expressions.push(args[++i] || '')
    } else if (arg.startsWith('--expression=')) {
      expressions.push(arg.slice(13))
    } else if (arg.startsWith('-e')) {
      expressions.push(arg.slice(2))
    } else if (arg === '-f' || arg === '--file') {
      if (i + 1 < args.length) scriptFile = args[++i]
    } else if (arg.startsWith('--file=')) {
      scriptFile = arg.slice(7)
    } else if (arg.startsWith('-f')) {
      scriptFile = arg.slice(2)
    } else if (arg === '-i' || arg === '--in-place') {
      inplace = ''
    } else if (arg.startsWith('--in-place=')) {
      inplace = arg.slice(12)
    } else if (arg.startsWith('-i')) {
      inplace = arg.slice(2) || ''
    } else if (arg === '-q' || arg === '--quiet') {
      quiet = true
    } else if (isSedExpression(arg)) {
      expressions.push(arg)
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    }
  }

  if (expressions.length === 0 && !scriptFile) {
    write(2, new TextEncoder().encode('sed: No expression provided\n'))
    return 1
  }

  const cwd = getcwd()
  const commands = []

  if (scriptFile) {
    const scriptPath = resolve(cwd, scriptFile)
    if (!exists(scriptPath)) {
      write(2, new TextEncoder().encode(`sed: ${scriptFile}: No such file or directory\n`))
      return 1
    }

    const scriptContent = new TextDecoder().decode(readWholeFile(scriptPath))
    const scriptLines = scriptContent.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))

    for (const line of scriptLines) {
      const cmd = parseSedExpression(line.trim())
      if (cmd) commands.push(cmd)
    }
  }

  for (const expr of expressions) {
    const cmd = parseSedExpression(expr)
    if (cmd) {
      commands.push(cmd)
    } else {
      write(2, new TextEncoder().encode(`sed: Invalid expression: ${expr}\n`))
      return 1
    }
  }

  if (commands.length === 0) {
    write(2, new TextEncoder().encode('sed: No valid commands found\n'))
    return 1
  }

  const processFile = (filePath) => {
    if (!exists(filePath)) {
      write(2, new TextEncoder().encode(`sed: ${filePath}: No such file or directory\n`))
      return []
    }
    if (isDirectory(filePath)) {
      write(2, new TextEncoder().encode(`sed: ${filePath}: Is a directory\n`))
      return []
    }
    const content = new TextDecoder().decode(readWholeFile(filePath))
    return content.split('\n')
  }

  const runLines = (inputLines, totalLines) => {
    const outputLines = []
    for (let i = 0; i < inputLines.length; i++) {
      let line = inputLines[i] || ''
      const lineNum = i + 1
      let shouldPrint = false

      for (const command of commands) {
        const { result, shouldPrint: print } = applySedCommand(line, lineNum, totalLines, command)
        if (result === null) {
          line = null
          break
        }
        line = result
        if (print) shouldPrint = true
      }

      if (line !== null) {
        outputLines.push(line)
        if (shouldPrint && !quiet) outputLines.push(line)
      }
    }
    return outputLines
  }

  try {
    if (inplace !== undefined && files.length > 0) {
      for (const file of files) {
        const fullPath = resolve(cwd, expandTilde(file))
        const fileLines = processFile(fullPath)
        if (fileLines.length === 0) continue

        const fileOutputLines = runLines(fileLines, fileLines.length)
        const fileOutput = fileOutputLines.join('\n')

        if (inplace) {
          const backupPath = `${fullPath}${inplace}`
          const originalContent = readWholeFile(fullPath)
          writeWholeFile(backupPath, originalContent)
        }

        writeWholeFile(fullPath, new TextEncoder().encode(fileOutput))
      }
    } else {
      let inputLines = []

      if (files.length > 0) {
        for (const file of files) {
          const fullPath = resolve(cwd, expandTilde(file))
          const lines = processFile(fullPath)
          inputLines.push(...lines)
          if (lines.length > 0 && inputLines.length > lines.length) inputLines.push('')
        }
      } else {
        inputLines = new TextDecoder().decode(readAllStdin()).split('\n')
      }

      const outputLines = runLines(inputLines, inputLines.length)
      write(1, new TextEncoder().encode(outputLines.join('\n')))
    }

    return 0
  } catch (error) {
    write(2, new TextEncoder().encode(`sed: ${error instanceof Error ? error.message : String(error)}\n`))
    return 1
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`sed: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
