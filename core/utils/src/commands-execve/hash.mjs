/**
 * Real `execve`'d `hash` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/hash.ts`) per `feat/1.0.0-execve-commands`. `crypto.subtle.digest` (Web
 * Crypto) is available inside a Web Worker by spec, unlike `window`/`document` -- no bridge needed.
 * See `head.mjs`'s doc comment for why there's no in-band interrupt handling and no `/dev`-path
 * special case anymore.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY } = globalThis.ecmaosSyscalls

const SUPPORTED_ALGORITHMS = {
  'sha1': 'SHA-1', 'sha-1': 'SHA-1',
  'sha256': 'SHA-256', 'sha-256': 'SHA-256',
  'sha384': 'SHA-384', 'sha-384': 'SHA-384',
  'sha512': 'SHA-512', 'sha-512': 'SHA-512'
}

const usage = `Usage: hash [OPTION]... [FILE]...
Compute and display hash values for files or standard input.

  -a, --algorithm=ALGORITHM  hash algorithm to use (sha1, sha256, sha384, sha512)
                              default: sha256
  --help                      display this help and exit`

async function hashData(data, algorithm) {
  const hashBuffer = await crypto.subtle.digest(algorithm, data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
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

async function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  let algorithm = 'SHA-256'
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-a' || arg === '--algorithm') {
      const algoArg = args[i + 1]
      if (!algoArg) {
        write(2, new TextEncoder().encode(`hash: option requires an argument -- '${arg === '-a' ? 'a' : 'algorithm'}'\n`))
        return 1
      }
      const selected = SUPPORTED_ALGORITHMS[algoArg.toLowerCase()]
      if (!selected) {
        write(2, new TextEncoder().encode(`hash: unsupported algorithm '${algoArg}'\nSupported algorithms: ${Object.keys(SUPPORTED_ALGORITHMS).join(', ')}\n`))
        return 1
      }
      algorithm = selected
      i++
    } else if (arg.startsWith('--algorithm=')) {
      const algoArg = arg.split('=')[1]
      if (!algoArg) {
        write(2, new TextEncoder().encode("hash: option requires an argument -- 'algorithm'\n"))
        return 1
      }
      const selected = SUPPORTED_ALGORITHMS[algoArg.toLowerCase()]
      if (!selected) {
        write(2, new TextEncoder().encode(`hash: unsupported algorithm '${algoArg}'\nSupported algorithms: ${Object.keys(SUPPORTED_ALGORITHMS).join(', ')}\n`))
        return 1
      }
      algorithm = selected
    } else if (!arg.startsWith('-')) {
      files.push(arg)
    } else {
      write(2, new TextEncoder().encode(`hash: invalid option -- '${arg.replace(/^-+/, '')}'\n`))
      write(2, new TextEncoder().encode("Try 'hash --help' for more information.\n"))
      return 1
    }
  }

  if (files.length === 0) {
    const data = readAllStdin()
    const hash = await hashData(data, algorithm)
    write(1, new TextEncoder().encode(hash + '\n'))
    return 0
  }

  const cwd = getcwd()
  let hasError = false

  for (const file of files) {
    const fullPath = resolve(cwd, file)
    try {
      const data = readWholeFile(fullPath)
      const hash = await hashData(data, algorithm)
      write(1, new TextEncoder().encode(`${hash}  ${file}\n`))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      write(2, new TextEncoder().encode(`hash: ${file}: ${message}\n`))
      hasError = true
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`hash: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
