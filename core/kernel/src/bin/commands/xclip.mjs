/** Copy to and paste from the browser clipboard: xclip, pbcopy and pbpaste. */

import { present } from './lib/present.mjs'
import { readAllStdin } from './lib/stdin.mjs'
import { resolvePath } from './lib/paths.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, open, read, close, stat, O_RDONLY } = syscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: xclip [OPTION] [FILE...]
Copy standard input (or the files) to the clipboard, or print the clipboard.

  -i, -in         copy to the clipboard (the default)
  -o, -out        print the clipboard to standard output
  -selection NAME accepted and ignored: there is one clipboard
  -sel NAME       the same
  -r, -rmlastnl   accepted and ignored
  --help          display this help and exit

pbcopy and pbpaste are the same program: pbcopy copies, pbpaste prints.`

function readFile(path) {
  const size = stat(path).size
  const fd = open(path, O_RDONLY)
  try {
    const bytes = new Uint8Array(size)
    let got = 0
    while (got < size) {
      const chunk = new Uint8Array(size - got)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      bytes.set(chunk.subarray(0, n), got)
      got += n
    }
    return new TextDecoder().decode(bytes.subarray(0, got))
  } finally { close(fd) }
}

async function main() {
  const name = (argv[0] ?? 'xclip').split('/').pop()
  const args = argv.slice(1)
  let mode = name === 'pbpaste' ? 'out' : 'in'
  const files = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { err(usage); return 0 }
    else if (arg === '-i' || arg === '-in') mode = 'in'
    else if (arg === '-o' || arg === '-out') mode = 'out'
    else if (arg === '-selection' || arg === '-sel' || arg === '-display' || arg === '-t' || arg === '-target') i++
    else if (arg === '-r' || arg === '-rmlastnl' || arg === '-quiet' || arg === '-silent' || arg === '-l' || arg === '-loops') { if (arg === '-l' || arg === '-loops') i++ }
    else if (arg.startsWith('-') && arg.length > 1) { err(`${name}: unknown option '${arg}'`); return 1 }
    else files.push(arg)
  }

  try {
    if (mode === 'out') {
      const { result } = await present(syscalls, 'clipboard-read', {})
      writeAll(1, encoder.encode(result.text))
      return 0
    }
    const text = files.length ? files.map(file => readFile(resolvePath(getcwd(), file))).join('') : readAllStdin(syscalls)
    await present(syscalls, 'clipboard-write', { text })
  } catch (error) {
    err(`${name}: ${error.message}`)
    return 1
  }
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`xclip: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
