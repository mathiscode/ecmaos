import type { promises } from '@zenfs/core'

import type { ProgramEntry } from './programs'

type Fs = Pick<typeof promises, 'readFile' | 'writeFile' | 'mkdir' | 'exists'>

/** The scope the groups and programs are published in */
const SCOPE = '@ecmaos-apps'

/** The version of every group and profile meta-package (`utils/apps-packages.mjs`) */
const META_VERSION = '1.0.0'

const DB_FILE = '/var/lib/install/db.json'
const LIB = '/usr/lib'

export interface ProfileCatalog {
  /** `{ group: { members: [program...] } }` */
  groups?: Record<string, { members: string[] }>
  /** `{ profile: { groups: [group...], packages?: [program...] } }` */
  profiles?: Record<string, { groups: string[], packages?: string[] }>
}

interface DbEntry {
  name: string
  version: string
  explicit: boolean
  dependencies: Record<string, string>
  installed: string
  linked?: boolean
  seeded?: boolean
  file?: string
  sha256?: string
}

const keyOf = (name: string, version: string) => `${name}@${version}`

/** The names `excluded.json` lists: group members taken out on purpose, which a boot does not bring back */
export async function readExcluded(fs: Pick<typeof promises, 'readFile'>): Promise<Set<string>> {
  try {
    const list = JSON.parse(String(await fs.readFile('/etc/ecmaos/profile.d/excluded.json', 'utf8')))
    return new Set(Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : [])
  } catch { return new Set() }
}

/** The programs the install database has from a package (not the boot's own copies): a boot leaves them to the package */
export async function readOwned(fs: Pick<typeof promises, 'readFile'>): Promise<Set<string>> {
  try {
    const db = JSON.parse(String(await fs.readFile(DB_FILE, 'utf8'))) as { packages?: Record<string, DbEntry> }
    return new Set(Object.values(db.packages ?? {}).filter(entry => !entry.seeded && entry.name.startsWith(`${SCOPE}/`)).map(entry => entry.name))
  } catch { return new Set() }
}

/**
 * Writes what a boot installed into the install database, so `install`, `apt` and `pacman` see it. Each program the
 * catalog wrote is a `seeded` entry (its file is `/bin/NAME`, there is no directory; an upgrade replaces the file with
 * the package's), the groups of the profile hold their members, and the profile is the one explicit package: removing
 * it lets `autoremove` take the rest. A program the database already has under any version is left as it is. The
 * profile is recorded only when every program of it is here, and only if no other profile is recorded.
 */
export async function recordProfile(fs: Fs, options: {
  catalog: ProfileCatalog
  profile: string
  /** The programs of the profile the catalog carries, with their entries */
  programs: { name: string, entry: ProgramEntry }[]
  /** Those of them that are installed */
  landed: Set<string>
}): Promise<number> {
  const { catalog, profile, programs, landed } = options
  let stored: { format?: number, packages?: Record<string, DbEntry> } = {}
  try { stored = JSON.parse(String(await fs.readFile(DB_FILE, 'utf8'))) } catch { /* no database yet */ }
  const packages = stored.packages ?? {}
  const now = new Date().toISOString()
  let written = 0
  const has = (name: string) => Object.values(packages).some(entry => entry.name === name)

  const versions = new Map<string, string>()
  for (const { name, entry } of programs) {
    if (!landed.has(name) || !entry.packageVersion) continue
    versions.set(name, entry.packageVersion)
    if (has(`${SCOPE}/${name}`)) continue
    packages[keyOf(`${SCOPE}/${name}`, entry.packageVersion)] = { name: `${SCOPE}/${name}`, version: entry.packageVersion, explicit: false, linked: true, seeded: true, file: `/bin/${name}`, sha256: entry.sha256, dependencies: {}, installed: now }
    written++
  }

  const definition = catalog.profiles?.[profile]
  // a profile that was recorded and is not this one (the file was changed by hand, or `profile set` reached the next boot) gives way
  for (const [key, entry] of Object.entries(packages)) {
    if (entry.name.startsWith(`${SCOPE}/profile-`) && entry.name !== `${SCOPE}/profile-${profile}`) { delete packages[key]; written++ }
  }
  const alreadyRecorded = Object.values(packages).some(entry => entry.name === `${SCOPE}/profile-${profile}`)
  const whole = definition && programs.every(({ name }) => landed.has(name))
  if (definition && whole && !alreadyRecorded) {
    const meta = async (name: string, dependencies: Record<string, string>, explicit: boolean) => {
      const full = `${SCOPE}/${name}`
      const directory = `${LIB}/${full}/${META_VERSION}`
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(`${directory}/package.json`, JSON.stringify({ name: full, version: META_VERSION, dependencies: Object.fromEntries(Object.keys(dependencies).map(dependency => [dependency, 'latest'])), ecmaos: { meta: true } }, null, 2) + '\n', { mode: 0o644 })
      packages[keyOf(full, META_VERSION)] = { name: full, version: META_VERSION, explicit, dependencies, installed: now }
      written++
    }
    const memberOf = (program: string) => versions.has(program) ? { [`${SCOPE}/${program}`]: versions.get(program)! } : {}
    const groupDependencies: Record<string, string> = {}
    for (const group of definition.groups) {
      const members = catalog.groups?.[group]?.members ?? []
      const dependencies = Object.assign({}, ...members.map(memberOf))
      if (!Object.keys(dependencies).length) continue
      await meta(`group-${group}`, dependencies, false)
      groupDependencies[`${SCOPE}/group-${group}`] = META_VERSION
    }
    await meta(`profile-${profile}`, { ...Object.assign({}, ...(definition.packages ?? []).map(memberOf)), ...groupDependencies }, true)
  }

  if (!written) return 0
  await fs.mkdir('/var/lib/install', { recursive: true })
  await fs.writeFile(DB_FILE, JSON.stringify({ format: stored.format ?? 1, packages }, null, 2) + '\n', { mode: 0o644 })
  return written
}
