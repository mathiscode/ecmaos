/**
 * Tab completion candidates for a command line.
 *
 * This was `Terminal.getCompletionMatches`, which reached into the shell for `env`, `cwd`,
 * `expandTilde`, `execute` and `context.fs.promises` directly, so nothing could complete without a
 * whole `Terminal` and `Shell` attached. It asks a {@link CompletionProvider} instead, which is the
 * seam a worker-hosted shell fills from its own syscalls.
 *
 * Each candidate is the *whole line* with the last word completed, not just the new word: the caller
 * cycles through them by replacing the line, which is how the terminal has always behaved.
 */

/** The three path operations this needs, so the module bundles for a worker (there is no `path` there). */
const normalize = (text: string): string => {
  const out: string[] = []
  for (const part of text.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}
const path = {
  resolve: (base: string, next: string): string => normalize(next.startsWith('/') ? next : `${base}/${next}`),
  join: (a: string, b: string): string => normalize(`${a}/${b}`),
  relative: (from: string, to: string): string => {
    const a = normalize(from).split('/').filter(Boolean)
    const b = normalize(to).split('/').filter(Boolean)
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
  },
}

export interface CompletionProvider {
  /** Directory entries, or a rejection if `dir` is not readable. */
  listDir(dir: string): Promise<string[]>
  isDirectory(target: string): Promise<boolean>
  variable(name: string): string | undefined
  readonly cwd: string
  expandTilde(text: string): string
  /** True shell builtins, which have no file under `$PATH` to be found by the scan. */
  builtins: Iterable<string>
}

/** Characters a completed filename needs escaped to survive being read back as one word. */
const ESCAPE = /([ ()[\]{}|&;<>`$"'\\])/g

/** Completion candidates for `partial`, each a complete replacement for the line. */
export async function completionMatches(partial: string, provider: CompletionProvider): Promise<string[]> {
  const parts = partial.split(' ')
  const lastWord = parts[parts.length - 1]
  if (!lastWord) return []

  const isPath = lastWord.startsWith('./') || lastWord.startsWith('/') || lastWord.startsWith('~')

  // The command position: builtins first (they have no `/bin/<name>`, as in bash), then everything on
  // `$PATH`, which already contains every real command's file.
  if (parts.length === 1 && !isPath) {
    const lower = lastWord.toLowerCase()
    const matches: string[] = [...provider.builtins].filter(name => name.toLowerCase().startsWith(lower))

    for (const dir of (provider.variable('PATH') || '').split(':')) {
      try {
        matches.push(...(await provider.listDir(dir)).filter(entry => entry.toLowerCase().startsWith(lower)))
      } catch {
        continue // a `$PATH` entry that does not exist is normal
      }
    }
    return [...new Set(matches)]
  }

  // A filename: expand `~` for the lookup, but give the completion back in the form it was typed.
  const expanded = provider.expandTilde(lastWord)
  const home = provider.variable('HOME') || ''
  const slash = expanded.lastIndexOf('/')
  const searchDir = slash !== -1 ? path.resolve(provider.cwd, expanded.substring(0, slash + 1)) : provider.cwd
  const searchTerm = slash !== -1 ? expanded.substring(slash + 1) : expanded

  try {
    const entries = (await provider.listDir(searchDir)).filter(entry =>
      !searchTerm || entry.toLowerCase().startsWith(searchTerm.toLowerCase()))

    const hadTilde = lastWord.startsWith('~')
    const prefix = slash !== -1 ? expanded.substring(0, slash + 1) : ''

    return await Promise.all(entries.map(async entry => {
      const full = path.join(searchDir, entry)
      const isDirectory = await provider.isDirectory(full)
      const escaped = entry.replace(ESCAPE, '\\$1')
      const withSlash = isDirectory ? escaped + '/' : escaped

      let completed: string
      if (hadTilde && home && full.startsWith(home + '/')) {
        const tilde = `~/${path.relative(home, full)}`
        completed = isDirectory && !tilde.endsWith('/') ? tilde + '/' : tilde
      } else if (hadTilde && home && full === home) {
        completed = '~' + (isDirectory ? '/' : '')
      } else {
        completed = prefix + withSlash
      }

      const next = [...parts]
      next[next.length - 1] = completed
      return next.join(' ')
    }))
  } catch {
    return []
  }
}
