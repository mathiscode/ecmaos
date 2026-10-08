/**
 * Machines. One origin can run several machines, each its own IndexedDB root, chosen by the page address (`?machine=work`).
 * The default machine (no parameter, or `?machine=root`) is the store `zenfs` (what the IndexedDB backend names its database by default) and the unscoped storage keys it has always used,
 * so an existing machine is untouched. Another machine is the store `zenfs-NAME`, and the few `localStorage` keys that describe
 * a store (what was installed into it, whether it has booted before) are kept under `ecmaos:machine:NAME:` so one machine's
 * stamps never make another believe it is already set up.
 */

export const MachineNamePattern = /^[a-z0-9][a-z0-9-]{0,31}$/

export const MachineKeyPrefix = 'ecmaos:machine:'

/** The machine a page address asks for: `undefined` for the default one, or `{ error }` for a name that is not allowed */
export function parseMachine(raw: string | null | undefined): { machine?: string, error?: string } {
  if (raw === undefined || raw === null || raw === '' || raw === 'root') return {}
  if (!MachineNamePattern.test(raw)) return { error: `'${raw.slice(0, 40)}' is not a machine name (lowercase letters, digits and dashes, up to 32)` }
  return { machine: raw }
}

/** The IndexedDB store of a machine */
export const machineStore = (machine: string | undefined) => machine ? `zenfs-${machine}` : 'zenfs'

/** A `localStorage` key that belongs to a machine's store */
export const machineKey = (machine: string | undefined, key: string) => machine ? `${MachineKeyPrefix}${machine}:${key}` : key

/** Whether `store` is some machine's root store (`zenfs` or `zenfs-NAME`) */
export const isMachineStore = (store: string) => store === 'zenfs' || store.startsWith('zenfs-')

/** A name for a new machine that no existing store uses, from the stores that exist */
export function freshMachineName(stores: string[], base = 'machine'): string {
  const taken = new Set(stores)
  for (let n = 2; ; n++) if (!taken.has(machineStore(`${base}-${n}`))) return `${base}-${n}`
}
