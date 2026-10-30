/**
 * What to tell someone who typed a command this system does not have: the package that provides it, from the package
 * index (its `commands` map, else an entry named like the command). Pure, so the shells and the `command-not-found`
 * program say the same thing.
 */

/** The package a command comes from: `{ command, package, provider }` (`provider` is the index name when it is not the command), or `undefined` */
export function providerOf(index, name) {
  if (!index?.common || !name) return undefined
  const indexName = index.commands?.[name] ?? (index.common[name] && !index.common[name].provided ? name : undefined)
  const entry = indexName && index.common[indexName]
  if (!entry || entry.provided || typeof entry.package !== 'string') return undefined
  return { command: name, package: entry.package, provider: indexName === name ? undefined : indexName, meta: Boolean(entry.meta) }
}

/**
 * The lines to print after `name: command not found`, or `undefined` when nothing is known. A program of the signed
 * scope needs the system's `/usr`, so a user is told to use `sudo`; anything else installs for the user.
 */
export function hintFor(index, name, { root = false } = {}) {
  const found = providerOf(index, name)
  if (!found || found.meta) return undefined
  const system = found.package.startsWith('@ecmaos-apps/')
  const command = system && !root ? `sudo install -g ${found.package}` : `install ${found.package}`
  const lead = found.provider ? `Command '${name}' not found, but it is part of '${found.provider}', which can be installed with:` : `Command '${name}' not found, but can be installed with:`
  return `${lead}\n  ${command}`
}
