import { PROFILES, type Profile, DEFAULT_PROFILE, inProfile } from './profiles'
import type { ProgramCatalog } from './programs'

/** The slice of the terminal the menu uses */
interface MenuTerminal {
  writeln(text: string): void
  write(text: string): void
  onKey(listener: (event: { key: string, domEvent: KeyboardEvent }) => void): { dispose(): void }
}

const TITLES: Record<Profile, string> = { minimal: 'Minimal', standard: 'Standard', developer: 'Developer', everything: 'Everything' }
const SUMMARIES: Record<Profile, string> = {
  minimal: 'the basics: bash, compression, system utilities, SSH',
  standard: 'plus vim, nano, tmux, sqlite, jq, htop and manual pages',
  developer: 'plus Python, Perl, ripgrep and other developer tools',
  everything: 'every program, games and demos included'
}

/** What each profile downloads, in bytes as the catalog says they are sent (`wire`); a profile whose programs have no size is left out */
export function profileSizes(catalog: ProgramCatalog): Partial<Record<Profile, number>> {
  const sizes: Partial<Record<Profile, number>> = {}
  const entries = catalog.packages.flatMap(pkg => Object.values(pkg.programs))
  for (const profile of PROFILES) {
    const parts = entries.filter(entry => inProfile(entry.profile, profile))
    if (parts.length && parts.every(entry => typeof entry.wire === 'number')) sizes[profile] = parts.reduce((sum, entry) => sum + (entry.wire ?? 0), 0)
  }
  return sizes
}

const megabytes = (bytes: number) => `about ${Math.max(1, Math.round(bytes / 1e6))} MB`

/**
 * The menu: the four profiles, 1 to 4 or Enter to choose, Standard when nothing is pressed for `seconds`. Resolves to
 * the profile, or to nothing if the terminal gave no keys at all and the time ran out (the caller then uses the default).
 */
export function askProfile(terminal: MenuTerminal, sizes: Partial<Record<Profile, number>>, seconds = 15): Promise<Profile | undefined> {
  terminal.writeln('')
  terminal.writeln('Welcome to ecmaOS. Which programs should this machine have?')
  terminal.writeln('')
  PROFILES.forEach((profile, index) => {
    const size = sizes[profile] !== undefined ? megabytes(sizes[profile]!) : ''
    terminal.writeln(`  ${index + 1}) ${TITLES[profile].padEnd(11)} ${size.padEnd(11)} ${SUMMARIES[profile]}${profile === DEFAULT_PROFILE ? '   [default]' : ''}`)
  })
  terminal.writeln('')
  terminal.writeln(`Press 1-4, or Enter for ${TITLES[DEFAULT_PROFILE]} (chosen for you after ${seconds} seconds). Change it later with \`profile set\`.`)
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (profile: Profile) => {
      clearTimeout(timer)
      listener.dispose()
      terminal.writeln(`\r\n${TITLES[profile]}.`)
      resolve(profile)
    }
    const listener = terminal.onKey(({ key, domEvent }) => {
      const number = Number(domEvent.key)
      if (number >= 1 && number <= PROFILES.length) done(PROFILES[number - 1]!)
      else if (domEvent.key === 'Enter' || key === '\r') done(DEFAULT_PROFILE)
    })
    timer = setTimeout(() => done(DEFAULT_PROFILE), seconds * 1000)
  })
}
