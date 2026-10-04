/**
 * A small `getopt(3)`: single-letter options that may be grouped (`-mr`), options that take a value (`-s /bin/sh`,
 * `-s/bin/sh`), long names mapped onto the letters (`--shell=/bin/sh`, `--shell /bin/sh`), and `--` to end them.
 * Returns `{ opts, rest }`, or `{ error }` for an option nobody declared or a value that is missing.
 */
export function getopt(args, { flags = '', values = '', long = {} }) {
  const opts = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { rest.push(...args.slice(i + 1)); break }
    if (arg === '--help') { opts.help = true; continue }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s)
      const letter = long[name]
      if (!letter) return { error: `unrecognized option '--${name}'` }
      if (values.includes(letter)) {
        const value = inline ?? args[++i]
        if (value === undefined) return { error: `option '--${name}' requires an argument` }
        opts[letter] = value
      } else opts[letter] = true
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]
        if (flags.includes(letter)) { opts[letter] = true; continue }
        if (values.includes(letter)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i]
          if (value === undefined) return { error: `option requires an argument -- '${letter}'` }
          opts[letter] = value
          break
        }
        return { error: `invalid option -- '${letter}'` }
      }
      continue
    }
    rest.push(arg)
  }
  return { opts, rest }
}

/** A non-negative integer from text, or undefined. */
export function integer(text) {
  return /^\d+$/.test(String(text)) ? Number(text) : undefined
}
