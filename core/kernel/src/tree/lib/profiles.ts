import type { promises } from '@zenfs/core'

type Fs = Pick<typeof promises, 'readFile' | 'writeFile' | 'mkdir' | 'exists'>

/**
 * The profiles a machine can be set up as, smallest first: each holds everything the one before it does. Which
 * programs belong to which is `utils/package-index/groups.json`; the catalog says it per program (`profile`, the smallest
 * profile that has it).
 */
export const PROFILES = ['minimal', 'standard', 'developer', 'everything'] as const
export type Profile = typeof PROFILES[number]

/** What a headless boot (Node, a script, a test) and a first boot nobody answered get */
export const DEFAULT_PROFILE: Profile = 'standard'

/** Where the machine's profile is written */
export const PROFILE_FILE = '/etc/ecmaos/profile'

export const isProfile = (value: unknown): value is Profile => typeof value === 'string' && (PROFILES as readonly string[]).includes(value)

/** Whether a program whose smallest profile is `tier` is part of `profile`; a program the catalog gives no tier is part of every one */
export const inProfile = (tier: string | undefined, profile: Profile): boolean => !isProfile(tier) || PROFILES.indexOf(tier) <= PROFILES.indexOf(profile)

/** The profile recorded for this machine, or `undefined` before the first boot has chosen one */
export async function readProfile(fs: Fs): Promise<Profile | undefined> {
  try {
    const value = String(await fs.readFile(PROFILE_FILE, 'utf8')).trim()
    return isProfile(value) ? value : undefined
  } catch { return undefined }
}

export async function writeProfile(fs: Fs, profile: Profile): Promise<void> {
  await fs.mkdir('/etc/ecmaos', { recursive: true })
  await fs.writeFile(PROFILE_FILE, `${profile}\n`, { mode: 0o644 })
}

export interface ProfileChoice {
  /** `KernelOptions.profile`, `?profile=` or `ECMAOS_PROFILE`: it wins over everything and is not recorded */
  requested?: string
  /** Whether the machine already has programs from the catalog (stamps) */
  hasPrograms: boolean
  /** Asks a person, on a first boot in an interactive host; resolves to nothing if nobody answers */
  ask?: () => Promise<Profile | undefined>
  /** A first boot with a person to ask, who is asked later (the terminal is not ready yet): nothing is recorded and `ask` is set in the answer */
  deferAsk?: boolean
}

/**
 * The profile a boot installs. A request wins and is not recorded; else the recorded one; else a machine that already has
 * programs becomes Everything (it keeps all it has, nothing is taken away); else a person chooses if there is one to ask,
 * and Standard is the answer when there is not. What is chosen or inferred is recorded.
 */
export async function resolveProfile(fs: Fs, choice: ProfileChoice): Promise<{ profile: Profile, recorded: boolean, ask?: true }> {
  if (isProfile(choice.requested)) return { profile: choice.requested, recorded: false }
  const recorded = await readProfile(fs)
  if (recorded) return { profile: recorded, recorded: true }
  if (!choice.hasPrograms && choice.deferAsk) return { profile: DEFAULT_PROFILE, recorded: false, ask: true }
  const profile = choice.hasPrograms ? 'everything' : (await choice.ask?.()) ?? DEFAULT_PROFILE
  await writeProfile(fs, profile)
  return { profile, recorded: true }
}
