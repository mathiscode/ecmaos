/**
 * Picks what to install for a set of requirements: the highest release that meets every range asked of a project, with a
 * pure-Python wheel that suits the interpreter, dependencies (`Requires-Dist`, markers evaluated) followed. A project a
 * dependent needs at another version than the one already chosen is chosen again against all the ranges; if none fits,
 * the conflict is reported. What is installed already counts, unless it is to be upgraded or does not fit.
 */

import { IndexError, pick } from './pypi.mjs'
import { applies, formatSpecifier, parseRequirement, satisfies } from './pep440.mjs'

/**
 * @param index the PyPI client
 * @param requests `[{ requirement, text, local? }]`: what was asked for (`local`: a wheel given as a file: `{ name, version, requires, bytes, filename }`)
 * @param options `python` (3.14), `env` (marker environment), `installed` (Map key -> distribution), `upgrade`, `force`, `noDeps`, `prereleases`, `onSatisfied(requirement, distribution, parent)`
 * @returns `{ order }`: nodes `{ key, name, version, file?, local?, requires, explicit, replaces? }`, dependencies before dependents
 */
export async function resolve(index, requests, { python, env, installed, upgrade = false, force = false, noDeps = false, prereleases = false, onSatisfied = () => {} }) {
  const chosen = new Map()
  const constraints = new Map()
  const extras = new Map()
  const order = []
  const queue = requests.map(request => ({ requirement: request.requirement, text: request.text, explicit: true, local: request.local }))

  const documentRequires = async (key, version, document) => {
    if (version === document.info?.version) return document.info.requires_dist ?? []
    return (await index.document(key, version)).info?.requires_dist ?? []
  }

  const enqueueDependencies = (node, wanted) => {
    if (noDeps) return
    for (const text of node.requires) {
      let requirement
      try { requirement = parseRequirement(text) } catch { continue }
      let applicable
      try { applicable = applies(requirement, env, ['', ...wanted]) } catch { applicable = false }
      if (applicable) queue.push({ requirement, text, explicit: false, parent: node })
    }
  }

  const fits = key => (constraints.get(key) ?? []).every(clauses => satisfies(chosen.get(key).version, clauses, { prereleases: true }))

  const choose = async (key, requirement, item) => {
    const document = await index.document(key)
    const picked = (() => {
      try {
        return pick(document, key, constraints.get(key) ?? [], { python, prereleases, label: `${key}${formatSpecifier(requirement.specifier)}` })
      } catch (error) {
        if (error instanceof IndexError && chosen.has(key)) {
          throw new IndexError(`Cannot install ${key}: conflicting dependencies. ${item.parent ? `${item.parent.key} ${item.parent.version} needs ${key}${formatSpecifier(requirement.specifier)}, ` : ''}but ${key}==${chosen.get(key).version} was already chosen for another requirement`)
        }
        throw error
      }
    })()
    return { document, picked }
  }

  while (queue.length) {
    const item = queue.shift()
    const { requirement } = item
    const key = requirement.name
    if (requirement.specifier.length) (constraints.get(key) ?? constraints.set(key, []).get(key)).push(requirement.specifier)
    const wanted = [...new Set([...(extras.get(key) ?? []), ...requirement.extras])]
    const newExtras = wanted.length > (extras.get(key)?.length ?? 0)
    extras.set(key, wanted)

    const have = chosen.get(key)
    if (have) {
      if (!fits(key)) {
        const { document, picked } = await choose(key, requirement, item)
        if (picked.version !== have.version) {
          const node = { ...have, version: picked.version, file: picked.file, requires: await documentRequires(key, picked.version, document) }
          chosen.set(key, node)
          order[order.indexOf(have)] = node
          enqueueDependencies(node, wanted)
          continue
        }
      }
      if (newExtras) enqueueDependencies(have, wanted)
      continue
    }

    if (item.local) {
      const node = { key, name: item.local.name, version: item.local.version, local: item.local, requires: item.local.requires ?? [], explicit: true, replaces: installed.get(key) }
      if (installed.get(key) && !force && installed.get(key).version === node.version && !upgrade) { onSatisfied(requirement, installed.get(key), item.parent); continue }
      chosen.set(key, node)
      order.push(node)
      enqueueDependencies(node, wanted)
      continue
    }

    const existing = installed.get(key)
    if (existing && !(upgrade && item.explicit) && !(force && item.explicit) && satisfies(existing.version, requirement.specifier, { prereleases: true })) {
      onSatisfied(requirement, existing, item.parent)
      continue
    }
    const { document, picked } = await choose(key, requirement, item)
    const node = { key, name: document.info?.name ?? key, version: picked.version, file: picked.file, requires: await documentRequires(key, picked.version, document), explicit: item.explicit, replaces: existing }
    // an upgrade that finds the version already installed has nothing to do
    if (existing && existing.version === node.version && !force) { onSatisfied(requirement, existing, item.parent); continue }
    chosen.set(key, node)
    order.push(node)
    enqueueDependencies(node, wanted)
  }

  // dependencies before dependents, so a package's imports are in place when its own install finishes
  const done = new Set()
  const sorted = []
  const visit = node => {
    if (done.has(node.key)) return
    done.add(node.key)
    for (const text of node.requires) {
      let name
      try { name = parseRequirement(text).name } catch { continue }
      const dependency = chosen.get(name)
      if (dependency && dependency !== node) visit(dependency)
    }
    sorted.push(node)
  }
  for (const node of order) visit(node)
  return { order: sorted, discovered: order }
}
