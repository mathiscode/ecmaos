/** What is newer than what is installed, from the registry: shared by `install` and the front-ends */

import semver from 'semver'

import { join } from '../path-utils.mjs'
import { readJson } from './io.mjs'

/** The newest version of every name in `entries`, from the registry: `{ name: { latest, document } }`; `warn` hears the failures */
export async function latestOf(registry, entries, warn = () => {}) {
  const result = {}
  await Promise.all([...new Set(entries.map(entry => entry.name))].map(async name => {
    try {
      const document = await registry.metadata(name)
      result[name] = { latest: document['dist-tags']?.latest, document }
    } catch (error) {
      warn(`${name}: ${error.message}`)
    }
  }))
  return result
}

/** The entries of `entries` that `latest` has a higher version of */
export const newer = (entries, latest) => entries.filter(entry => latest[entry.name]?.latest && semver.gt(latest[entry.name].latest, entry.version))

/** The range `entry`'s own `package.json` asks of `name` */
export function rangeOf(db, entry, name) {
  const manifest = readJson(join(db.scope.lib, entry.name, entry.version, 'package.json'), {})
  return manifest.dependencies?.[name] ?? manifest.optionalDependencies?.[name] ?? manifest.peerDependencies?.[name]
}

/** The newest version cached for each installed name, without asking the registry; how many installed packages have a newer one */
export function cachedUpgradable(registry, entries) {
  return entries.filter(entry => {
    const latest = registry.cached(entry.name)?.['dist-tags']?.latest
    return latest && semver.gt(latest, entry.version)
  })
}
