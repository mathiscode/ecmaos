import path from 'path'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalEvents } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

type HashAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'

const SUPPORTED_ALGORITHMS: Record<string, HashAlgorithm> = {
  'sha1': 'SHA-1',
  'sha-1': 'SHA-1',
  'sha256': 'SHA-256',
  'sha-256': 'SHA-256',
  'sha384': 'SHA-384',
  'sha-384': 'SHA-384',
  'sha512': 'SHA-512',
  'sha-512': 'SHA-512'
}

function printUsage(io: CommandIO): void {
  const usage = `Usage: hash [OPTION]... [FILE]...
Compute and display hash values for files or standard input.

  -a, --algorithm=ALGORITHM  hash algorithm to use (sha1, sha256, sha384, sha512)
                              default: sha256
  --help                      display this help and exit

Supported algorithms:
  sha1, sha-1                 SHA-1 (160 bits)
  sha256, sha-256            SHA-256 (256 bits) [default]
  sha384, sha-384            SHA-384 (384 bits)
  sha512, sha-512            SHA-512 (512 bits)

Examples:
  hash file.txt              compute SHA-256 hash of file.txt
  hash -a sha512 file.txt    compute SHA-512 hash of file.txt
  echo "hello" | hash        compute SHA-256 hash of stdin`
  io.writelnErr(usage)
}

async function hashData(data: Uint8Array, algorithm: HashAlgorithm): Promise<string> {
  // Create a new Uint8Array with a proper ArrayBuffer to ensure compatibility
  const dataCopy = new Uint8Array(data)
  const hashBuffer = await crypto.subtle.digest(algorithm, dataCopy)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function readStreamToUint8Array(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Calculate total length
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  
  // Concatenate all chunks into a single Uint8Array
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  
  return result
}

export const meta = { command: 'hash', description: 'Compute and display hash values for files or standard input' } as const

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    ...meta,
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {
      const process = ctx.process

      if (!process) return 1

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      let algorithm: HashAlgorithm = 'SHA-256'
      const files: string[] = []

      // Parse arguments
      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (arg === undefined) continue

        if (arg === '--help' || arg === '-h') {
          printUsage(io)
          return 0
        } else if (arg === '-a' || arg === '--algorithm') {
          const algoArg = ctx.argv[i + 1]
          if (!algoArg) {
            await io.writelnErr(`hash: option requires an argument -- '${arg === '-a' ? 'a' : 'algorithm'}'`)
            return 1
          }
          const algoLower = algoArg.toLowerCase()
          const selectedAlgorithm = SUPPORTED_ALGORITHMS[algoLower]
          if (!selectedAlgorithm) {
            await io.writelnErr(`hash: unsupported algorithm '${algoArg}'\nSupported algorithms: ${Object.keys(SUPPORTED_ALGORITHMS).join(', ')}`)
            return 1
          }
          algorithm = selectedAlgorithm
          i++ // Skip the next argument as it's the algorithm value
        } else if (arg.startsWith('--algorithm=')) {
          const algoArg = arg.split('=')[1]
          if (!algoArg) {
            await io.writelnErr(`hash: option requires an argument -- 'algorithm'`)
            return 1
          }
          const algoLower = algoArg.toLowerCase()
          const selectedAlgorithm = SUPPORTED_ALGORITHMS[algoLower]
          if (!selectedAlgorithm) {
            await io.writelnErr(`hash: unsupported algorithm '${algoArg}'\nSupported algorithms: ${Object.keys(SUPPORTED_ALGORITHMS).join(', ')}`)
            return 1
          }
          algorithm = selectedAlgorithm
        } else if (!arg.startsWith('-')) {
          files.push(arg)
        } else {
          await io.writelnErr(`hash: invalid option -- '${arg.replace(/^-+/, '')}'`)
          await io.writelnErr(`Try 'hash --help' for more information.`)
          return 1
        }
      }

      const writer = io.stdout!.getWriter()

      try {
        // If no files specified, read from stdin
        if (files.length === 0) {
          if (!io.stdin) {
            await io.writelnErr('hash: no input specified')
            return 1
          }

          const reader = io.stdin.getReader()
          const data = await readStreamToUint8Array(reader)
          const hash = await hashData(data, algorithm)
          await writer.write(new TextEncoder().encode(hash + '\n'))
          return 0
        }

        // Process each file
        let hasError = false
        for (const file of files) {
          const fullPath = path.resolve(shell.cwd, file)

          let interrupted = false
          const interruptHandler = () => { interrupted = true }
          kernel.terminal.events.on(TerminalEvents.INTERRUPT, interruptHandler)

          try {
            if (fullPath.startsWith('/dev')) {
              await io.writelnErr(`hash: ${file}: cannot hash device files`)
              hasError = true
              continue
            }

            const handle = await shell.context.fs.promises.open(fullPath, 'r')
            const stat = await shell.context.fs.promises.stat(fullPath)

            const chunks: Uint8Array[] = []
            let bytesRead = 0
            const chunkSize = 64 * 1024 // 64KB chunks for better performance

            while (bytesRead < stat.size) {
              if (interrupted) break
              const data = new Uint8Array(chunkSize)
              const readSize = Math.min(chunkSize, stat.size - bytesRead)
              await handle.read(data, 0, readSize, bytesRead)
              chunks.push(data.subarray(0, readSize))
              bytesRead += readSize
            }

            // Concatenate all chunks
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            const fileData = new Uint8Array(totalLength)
            let offset = 0
            for (const chunk of chunks) {
              fileData.set(chunk, offset)
              offset += chunk.length
            }

            const hash = await hashData(fileData, algorithm)
            await writer.write(new TextEncoder().encode(`${hash}  ${file}\n`))
          } catch (error) {
            await io.writelnErr(`hash: ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`)
            hasError = true
          } finally {
            kernel.terminal.events.off(TerminalEvents.INTERRUPT, interruptHandler)
          }
        }

        return hasError ? 1 : 0
      } finally {
        writer.releaseLock()
      }
    }
  })
}
