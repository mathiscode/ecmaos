/** Print the prime factors of each given number, or read numbers from stdin if none are given. */

const { argv, exit, writeAll, read } = globalThis.ecmaosSyscalls

const usage = `Usage: factor [NUMBER]...
Print prime factors of each NUMBER.

  --help  display this help and exit`

function factorize(n) {
  if (n < 2) return [n]

  const factors = []
  let num = n

  while (num % 2 === 0) { factors.push(2); num /= 2 }
  for (let i = 3; i * i <= num; i += 2) {
    while (num % i === 0) { factors.push(i); num /= i }
  }
  if (num > 2) factors.push(num)

  return factors
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    writeAll(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const numbers = []

  for (const arg of args) {
    if (!arg.startsWith('-')) {
      numbers.push(arg)
    } else {
      writeAll(2, new TextEncoder().encode(`factor: invalid option -- '${arg.slice(1)}'\n`))
      writeAll(2, new TextEncoder().encode("Try 'factor --help' for more information.\n"))
      return 1
    }
  }

  if (numbers.length === 0) {
    const text = readAllStdin()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) numbers.push(...trimmed.split(/\s+/))
    }
  }

  if (numbers.length === 0) {
    writeAll(2, new TextEncoder().encode('factor: missing operand\n'))
    writeAll(2, new TextEncoder().encode("Try 'factor --help' for more information.\n"))
    return 1
  }

  let hasError = false
  let output = ''

  for (const numStr of numbers) {
    const num = parseInt(numStr, 10)
    if (isNaN(num) || num < 0) {
      writeAll(2, new TextEncoder().encode(`factor: '${numStr}' is not a valid positive integer\n`))
      hasError = true
      continue
    }
    output += `${num}: ${factorize(num).join(' ')}\n`
  }
  writeAll(1, new TextEncoder().encode(output))

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  writeAll(2, new TextEncoder().encode(`factor: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
