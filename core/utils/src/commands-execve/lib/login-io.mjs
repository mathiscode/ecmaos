/**
 * What `getty` and `login` share: reading a line from the terminal and a few file helpers. Each takes the
 * syscalls it needs rather than reaching for the global, so it can be tested.
 */

const ECHO = 0o10
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function makeLoginIO(sys) {
  const { read, writeAll, open, close, unlink, tcgetattr, tcsetattr, O_RDONLY } = sys

  const out = text => writeAll(1, encoder.encode(text))

  function readFile(path) {
    try {
      const fd = open(path, O_RDONLY, 0)
      try {
        const chunks = []
        const buffer = new Uint8Array(65536)
        for (;;) {
          const n = read(fd, buffer, -1)
          if (n <= 0) break
          chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
        }
        return chunks.join('')
      } finally {
        close(fd)
      }
    } catch {
      return undefined
    }
  }

  /** A `read` that a signal cut short: the line being typed is dropped and the prompt comes back. */
  const isInterrupt = error => `${error?.code} ${error?.message ?? error}`.includes('EINTR')

  /** One line from the terminal, without its newline. Null at end of input. */
  function readLine() {
    const bytes = []
    const buffer = new Uint8Array(1)
    for (;;) {
      const n = read(0, buffer, -1)
      if (n <= 0) return bytes.length ? decoder.decode(new Uint8Array(bytes)) : null
      if (buffer[0] === 10) return decoder.decode(new Uint8Array(bytes))
      bytes.push(buffer[0])
    }
  }

  /** Echo goes off before the prompt is shown, so nothing typed the moment it appears can be echoed. */
  function readSilent(prompt) {
    const lflag = tcgetattr(0).lflag
    tcsetattr(0, { lflag: lflag & ~ECHO })
    try {
      out(prompt)
      return readLine()
    } finally {
      tcsetattr(0, { lflag })
      out('\n')
    }
  }

  return { out, readFile, readLine, readSilent, isInterrupt, unlink }
}
