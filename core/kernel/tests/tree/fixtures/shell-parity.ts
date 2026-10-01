/** One entry of the shell parity corpus; see `shell-parity.corpus.txt` for the format. */
export interface ParityCase {
  /** `group/name` */
  id: string
  script: string
  /** Runs in a fresh /tmp/pc directory */
  fs: boolean
}

export interface ParityGolden {
  stdout: string
  status: number
}

/** The preamble that gives an `fs` case an empty working directory. */
export const FS_PREAMBLE = 'rm -rf /tmp/pc; mkdir -p /tmp/pc; cd /tmp/pc\n'

export function parseCorpus(text: string): ParityCase[] {
  const cases: ParityCase[] = []
  let current: { id: string, fs: boolean, lines: string[] } | undefined
  const flush = () => {
    if (current) cases.push({ id: current.id, fs: current.fs, script: current.lines.join('\n').replace(/\n+$/, '') + '\n' })
  }
  for (const line of text.split('\n')) {
    const header = /^### (\S+)((?:\s+\S+)*)$/.exec(line)
    if (header) {
      flush()
      current = { id: header[1] as string, fs: /\bfs\b/.test(header[2] ?? ''), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  return cases
}
