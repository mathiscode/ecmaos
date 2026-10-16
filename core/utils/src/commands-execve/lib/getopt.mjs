/**
 * `getopt_long` as GNU coreutils use it: clustered short options (`-rf`), an attached or separate argument (`-ofile`,
 * `-o file`), long options with `=` or a separate argument, unambiguous abbreviations (`--rec` for `--recursive`),
 * `--` ending options, and operands permuted among the options (`rm a -r b`) unless `POSIXLY_CORRECT` is set or
 * `permute` is false, when the first operand ends them.
 *
 * `short` is a getopt(3) string (`'rfv'`, `'o:'` takes an argument, `'o::'` an optional attached one). `long` maps a
 * long name to the key it reports, or to `{ key, arg }` with `arg` `'required'` or `'optional'`. Each option parsed is
 * reported as `[key, value]` in command-line order (`value` is `true` without an argument), so a later option can
 * override an earlier one. A bad command line returns `{ error }` with the GNU wording and no program prefix.
 */

/** @returns {{ options: Array<[string, string | true]>, operands: string[], error?: string }} */
export function getopt(args, { short = '', long = {}, permute } = {}) {
  const posix = permute === undefined ? Boolean(globalThis.ecmaosSyscalls?.env?.POSIXLY_CORRECT) : !permute
  const shortSpec = {}
  for (let i = 0; i < short.length; i++) {
    const letter = short[i]
    if (letter === ':') continue
    let arg = 'none'
    if (short[i + 1] === ':') arg = short[i + 2] === ':' ? 'optional' : 'required'
    shortSpec[letter] = arg
  }
  const longSpec = {}
  for (const [name, spec] of Object.entries(long)) longSpec[name] = typeof spec === 'string' ? { key: spec, arg: 'none' } : { arg: 'none', ...spec }

  const options = []
  const operands = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const given = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      let name = given in longSpec ? given : undefined
      if (name === undefined) {
        const matches = Object.keys(longSpec).filter(candidate => candidate.startsWith(given))
        // Abbreviations that all name the same option are not ambiguous
        const distinct = new Set(matches.map(candidate => longSpec[candidate].key))
        if (matches.length === 0) return { options, operands, error: `unrecognized option '--${given}'` }
        if (distinct.size > 1) return { options, operands, error: `option '--${given}' is ambiguous; possibilities:${matches.map(m => ` '--${m}'`).join('')}` }
        name = matches[0]
      }
      const { key, arg: kind } = longSpec[name]
      if (kind === 'none') {
        if (eq !== -1) return { options, operands, error: `option '--${name}' doesn't allow an argument` }
        options.push([key, true])
      } else if (eq !== -1) options.push([key, arg.slice(eq + 1)])
      else if (kind === 'optional') options.push([key, true])
      else {
        if (i + 1 >= args.length) return { options, operands, error: `option '--${name}' requires an argument` }
        options.push([key, args[++i]])
      }
    } else if (arg.length > 1 && arg[0] === '-') {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]
        const kind = shortSpec[letter]
        if (kind === undefined) return { options, operands, error: `invalid option -- '${letter}'` }
        if (kind === 'none') { options.push([letter, true]); continue }
        const rest = arg.slice(j + 1)
        if (rest) options.push([letter, rest])
        else if (kind === 'optional') options.push([letter, true])
        else {
          if (i + 1 >= args.length) return { options, operands, error: `option requires an argument -- '${letter}'` }
          options.push([letter, args[++i]])
        }
        break
      }
    } else if (posix) { operands.push(...args.slice(i)); break }
    else operands.push(arg)
  }
  return { options, operands }
}

/** The `Try 'name --help' for more information.` line GNU programs print after a usage error */
export function tryHelp(name) {
  return `Try '${name} --help' for more information.`
}
