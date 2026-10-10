/** Speak text aloud with the browser's speech synthesis. */

import { present } from './lib/present.mjs'
import { readAllStdin } from './lib/stdin.mjs'
import { resolvePath } from './lib/paths.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, open, read, close, stat, O_RDONLY } = syscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: say [-v VOICE] [-r RATE] [-p PITCH] [-l LANG] [-f FILE] [TEXT...]
Speak TEXT, the file, or standard input.

  -v, --voice=NAME   the voice to use; '-v ?' lists them
  -r, --rate=N       speed, as a multiple of normal (1 is normal)
  -p, --pitch=N      pitch, from 0 to 2 (1 is normal)
  -l, --lang=TAG     a language tag such as en-GB
  -f, --input-file=F read the text from a file ('-' is standard input)
  --help             display this help and exit`

async function main() {
  const args = argv.slice(1)
  const words = []
  let voice, rate, pitch, lang, file
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i]
    if (arg === '--help') { err(usage); return 0 }
    else if (arg === '-v' || arg.startsWith('--voice')) voice = value()
    else if (arg === '-r' || arg.startsWith('--rate')) rate = Number(value())
    else if (arg === '-p' || arg.startsWith('--pitch')) pitch = Number(value())
    else if (arg === '-l' || arg.startsWith('--lang')) lang = value()
    else if (arg === '-f' || arg.startsWith('--input-file')) file = value()
    else words.push(arg)
  }
  if ((rate !== undefined && !Number.isFinite(rate)) || (pitch !== undefined && !Number.isFinite(pitch))) { err('say: rate and pitch must be numbers'); return 1 }

  try {
    if (voice === '?') {
      const { result } = await present(syscalls, 'speak', { voices: true })
      writeAll(1, encoder.encode(result.voices.map(v => `${v.name.padEnd(32)} ${v.lang}`).join('\n') + (result.voices.length ? '\n' : '')))
      return 0
    }
    let text = words.join(' ')
    if (file === '-') text = readAllStdin(syscalls)
    else if (file) {
      const path = resolvePath(getcwd(), file)
      const fd = open(path, O_RDONLY)
      try {
        const bytes = new Uint8Array(stat(path).size)
        let got = 0
        while (got < bytes.length) { const chunk = new Uint8Array(bytes.length - got); const n = read(fd, chunk, -1); if (n <= 0) break; bytes.set(chunk.subarray(0, n), got); got += n }
        text = new TextDecoder().decode(bytes.subarray(0, got))
      } finally { close(fd) }
    } else if (!text) text = readAllStdin(syscalls)
    if (!text.trim()) { err('say: nothing to say'); return 1 }
    await present(syscalls, 'speak', { text, voice, rate, pitch, lang })
  } catch (error) {
    err(`say: ${error.message}`)
    return 1
  }
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`say: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
