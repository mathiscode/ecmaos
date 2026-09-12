/**
 * Real `execve`'d `dd` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/dd.ts`) per `feat/1.0.0-execve-commands`. The original had a separate
 * code path for `/dev`-path input (streamed via a device file handle, no real byte-count `stat`)
 * versus regular files, plus a stdin-stream fallback when `if=` was omitted. Here there is only one
 * path: fd 0 is a real, syscall-backed file descriptor exactly like any other, so `if=`-omitted and
 * `if=/dev/...` and `if=<regular file>` are all just "read fd N with `read(fd, buffer, position)`" --
 * the old `/dev`-special-casing and the stdin-vs-file branching both collapse into one loop. See
 * `head.mjs`'s doc comment for why there's no in-band interrupt handling anymore either.
 */

import { resolve } from './lib/path-utils.mjs'

const { argv, exit, write, read, getcwd, open, close, stat, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: dd [OPERAND]...
Copy a file, converting and formatting according to the operands.

Operands:

  if=FILE     read from FILE instead of stdin
  of=FILE     write to FILE instead of stdout
  bs=BYTES    read and write up to BYTES bytes at a time
  ibs=BYTES   read up to BYTES bytes at a time (default: 512)
  obs=BYTES   write BYTES bytes at a time (default: 512)
  count=N     copy only N input blocks
  skip=N      skip N input blocks before copying
  seek=N      skip N output blocks before copying
  conv=CONVS  convert the file as per the comma separated symbol list:
                ucase    convert to uppercase
                lcase    convert to lowercase
                swab     swap every pair of input bytes
                noerror  continue after read errors
                notrunc  do not truncate the output file
                sync     pad every input block to ibs

  status=LEVEL
              The LEVEL of information to print to stderr:
                'none'     suppress all output
                'noxfer'   suppress final transfer statistics
                'progress' show periodic transfer statistics

  --help      display this help and exit`

function parseBytes(value) {
  const match = value.match(/^([0-9]+)([kmgKMG]?)$/)
  if (!match?.[1]) return NaN
  const num = parseInt(match[1], 10)
  if (isNaN(num)) return NaN
  const suffix = (match[2] || '').toLowerCase()
  switch (suffix) {
    case 'k': return num * 1024
    case 'm': return num * 1024 * 1024
    case 'g': return num * 1024 * 1024 * 1024
    default: return num
  }
}

function parseBlocks(value) {
  const num = parseInt(value, 10)
  return isNaN(num) ? NaN : num
}

function applyConversions(data, conversions) {
  let result = new Uint8Array(data)
  for (const conv of conversions) {
    if (conv === 'ucase') {
      result = new TextEncoder().encode(new TextDecoder().decode(result).toUpperCase())
    } else if (conv === 'lcase') {
      result = new TextEncoder().encode(new TextDecoder().decode(result).toLowerCase())
    } else if (conv === 'swab') {
      const swapped = new Uint8Array(result.length)
      for (let i = 0; i < result.length - 1; i += 2) {
        swapped[i] = result[i + 1]
        swapped[i + 1] = result[i]
      }
      if (result.length % 2 === 1) swapped[result.length - 1] = result[result.length - 1]
      result = swapped
    }
  }
  return result
}

function writeErr(message) {
  write(2, new TextEncoder().encode(message + '\n'))
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeErr(usage)
    return 0
  }

  let inputFile
  let outputFile
  let blockSize
  let inputBlockSize = 512
  let outputBlockSize = 512
  let count
  let skip = 0
  let seek = 0
  const conversions = []
  let status = 'noxfer'
  let noError = false
  let noTrunc = false
  let sync = false

  for (const arg of args) {
    if (!arg) continue
    if (arg === '--help' || arg === '-h') {
      writeErr(usage)
      return 0
    } else if (arg.startsWith('if=')) {
      inputFile = arg.slice(3)
    } else if (arg.startsWith('of=')) {
      outputFile = arg.slice(3)
    } else if (arg.startsWith('bs=')) {
      const bytes = parseBytes(arg.slice(3))
      if (isNaN(bytes)) { writeErr(`dd: invalid block size: ${arg.slice(3)}`); return 1 }
      blockSize = bytes
      inputBlockSize = bytes
      outputBlockSize = bytes
    } else if (arg.startsWith('ibs=')) {
      const bytes = parseBytes(arg.slice(4))
      if (isNaN(bytes)) { writeErr(`dd: invalid input block size: ${arg.slice(4)}`); return 1 }
      inputBlockSize = bytes
    } else if (arg.startsWith('obs=')) {
      const bytes = parseBytes(arg.slice(4))
      if (isNaN(bytes)) { writeErr(`dd: invalid output block size: ${arg.slice(4)}`); return 1 }
      outputBlockSize = bytes
    } else if (arg.startsWith('count=')) {
      const blocks = parseBlocks(arg.slice(6))
      if (isNaN(blocks)) { writeErr(`dd: invalid count: ${arg.slice(6)}`); return 1 }
      count = blocks
    } else if (arg.startsWith('skip=')) {
      const blocks = parseBlocks(arg.slice(5))
      if (isNaN(blocks)) { writeErr(`dd: invalid skip: ${arg.slice(5)}`); return 1 }
      skip = blocks
    } else if (arg.startsWith('seek=')) {
      const blocks = parseBlocks(arg.slice(5))
      if (isNaN(blocks)) { writeErr(`dd: invalid seek: ${arg.slice(5)}`); return 1 }
      seek = blocks
    } else if (arg.startsWith('conv=')) {
      const convs = arg.slice(5).split(',').map(c => c.trim())
      for (const conv of convs) {
        if (['ucase', 'lcase', 'swab', 'noerror', 'notrunc', 'sync'].includes(conv)) {
          if (conv === 'noerror') noError = true
          else if (conv === 'notrunc') noTrunc = true
          else if (conv === 'sync') sync = true
          else conversions.push(conv)
        } else {
          writeErr(`dd: invalid conversion: ${conv}`)
          return 1
        }
      }
    } else if (arg.startsWith('status=')) {
      const level = arg.slice(7)
      if (['none', 'noxfer', 'progress'].includes(level)) status = level
      else { writeErr(`dd: invalid status level: ${level}`); return 1 }
    } else {
      writeErr(`dd: invalid operand: ${arg}`)
      writeErr("Try 'dd --help' for more information.")
      return 1
    }
  }

  if (blockSize !== undefined) {
    inputBlockSize = blockSize
    outputBlockSize = blockSize
  }

  const cwd = getcwd()
  let inputFd = 0
  let outputFd = 1
  let closeInput = false
  let closeOutput = false

  let totalBytesRead = 0
  let totalBytesWritten = 0
  let blocksRead = 0
  let blocksWritten = 0
  let outputPosition = 0

  try {
    if (inputFile) {
      const inputPath = resolve(cwd, inputFile)
      inputFd = open(inputPath, O_RDONLY)
      closeInput = true
    }

    if (outputFile) {
      const outputPath = resolve(cwd, outputFile)
      outputFd = open(outputPath, O_WRONLY | O_CREAT | (noTrunc ? 0 : O_TRUNC), 0o644)
      closeOutput = true
    }

    if (seek > 0) {
      if (outputFile) {
        outputPosition = seek * outputBlockSize
      } else {
        write(outputFd, new Uint8Array(seek * outputBlockSize))
      }
    }

    let inputPosition = inputFile ? skip * inputBlockSize : -1
    if (!inputFile && skip > 0) {
      // Streaming input (fd 0 / a pipe): skip means "discard N blocks worth of bytes read", not a seek.
      let toSkip = skip * inputBlockSize
      const skipBuf = new Uint8Array(inputBlockSize)
      while (toSkip > 0) {
        const n = read(inputFd, skipBuf.subarray(0, Math.min(inputBlockSize, toSkip)), -1)
        if (n <= 0) break
        toSkip -= n
      }
    }

    const buffer = new Uint8Array(inputBlockSize)

    while (true) {
      if (count !== undefined && blocksRead >= count) break

      const n = read(inputFd, buffer, inputPosition)
      if (n <= 0) {
        if (sync && blocksRead > 0) {
          let data = new Uint8Array(inputBlockSize)
          if (conversions.length > 0) data = applyConversions(data, conversions)
          if (outputFile) { write(outputFd, data, outputPosition); outputPosition += data.length }
          else write(outputFd, data)
          totalBytesWritten += data.length
          blocksWritten++
        }
        break
      }

      if (inputPosition >= 0) inputPosition += n

      let data = buffer.subarray(0, n)
      totalBytesRead += data.length
      blocksRead++

      if (data.length < inputBlockSize && sync) {
        const padded = new Uint8Array(inputBlockSize)
        padded.set(data)
        data = padded
      }

      if (conversions.length > 0) data = applyConversions(data, conversions)

      if (data.length > outputBlockSize) {
        let offset = 0
        while (offset < data.length) {
          const chunk = data.subarray(offset, offset + outputBlockSize)
          if (outputFile) { write(outputFd, chunk, outputPosition); outputPosition += chunk.length }
          else write(outputFd, chunk)
          totalBytesWritten += chunk.length
          blocksWritten++
          offset += outputBlockSize
        }
      } else {
        if (outputFile) { write(outputFd, data, outputPosition); outputPosition += data.length }
        else write(outputFd, data)
        totalBytesWritten += data.length
        blocksWritten++
      }

      if (status === 'progress' && blocksRead % 100 === 0) {
        writeErr(`dd: ${blocksRead} blocks read, ${blocksWritten} blocks written`)
      }
    }

    if (status !== 'none') {
      writeErr(`${blocksRead}+${Math.floor((totalBytesRead % inputBlockSize) / (inputBlockSize || 1))} records in`)
      writeErr(`${blocksWritten}+${Math.floor((totalBytesWritten % outputBlockSize) / (outputBlockSize || 1))} records out`)
      writeErr(`${totalBytesWritten} bytes copied`)
    }

    return 0
  } catch (error) {
    if (!noError) {
      writeErr(`dd: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
    return 0
  } finally {
    if (closeInput) close(inputFd)
    if (closeOutput) close(outputFd)
  }
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`dd: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
