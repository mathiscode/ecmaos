/**
 * One tab per machine. Each tab loads the IndexedDB root whole and takes file ids from its copy, so two tabs would
 * overwrite each other. A Web Lock named for the store, held while the kernel runs, keeps a second tab out; the
 * browser releases it when the tab closes or crashes.
 */

export interface MachineLock {
  /** Gives the machine up (shutdown, halt): another tab may take it */
  release(): void
  /**
   * Resolves if another tab took the machine from this one (see {@link stealMachineLock}); this tab must stop writing
   * at once
   */
  readonly evicted: Promise<void>
}

export const machineLockName = (store: string) => `ecmaos:machine:${store}`

/**
 * Holds `name` until released, resolving to the lock once granted (or `undefined` when `ifAvailable` found it taken)
 */
function hold(locks: LockManager, name: string, options: LockOptions): Promise<MachineLock | undefined> {
  return new Promise((resolve, reject) => {
    let release!: () => void
    const held = new Promise<void>(done => { release = done })
    let evict!: () => void
    const evicted = new Promise<void>(done => { evict = done })
    let granted = false
    let request: Promise<unknown>
    try {
      request = locks.request(name, options, async lock => {
        if (!lock) { resolve(undefined); return }
        granted = true
        resolve({ release, evicted })
        await held
      })
    } catch (error) { reject(error); return }
    request.catch(error => {
      if (!granted) { reject(error); return }
      // The browser rejects the holder's request when another tab steals the lock
      if ((error as { name?: string })?.name === 'AbortError') evict()
    })
  })
}

/**
 * The lock for `store` if nobody has it, else `undefined`. Rejects when the platform refuses locks (an insecure
 * context).
 */
export function acquireMachineLock(locks: LockManager, store: string): Promise<MachineLock | undefined> {
  return hold(locks, machineLockName(store), { ifAvailable: true })
}

/** Waits for the lock to be free (the other tab closed or halted). Aborting `signal` gives up. */
export function waitForMachineLock(locks: LockManager, store: string, signal: AbortSignal): Promise<MachineLock | undefined> {
  return hold(locks, machineLockName(store), { signal }) as Promise<MachineLock | undefined>
}

/** Takes the lock from whichever tab has it. That tab's {@link MachineLock.evicted} resolves. */
export async function stealMachineLock(locks: LockManager, store: string): Promise<MachineLock> {
  return (await hold(locks, machineLockName(store), { steal: true }))!
}

export interface MachineBusyUi {
  /**
   * Tells the user another tab has the machine; `takeOver` is what the "use it here" button calls, and `guest` runs a
   * scratch
   * machine in this tab instead (nothing saved, the other tab untouched). Returns how to take the message down.
   */
  busy(takeOver: () => void, guest: () => void): { close(): void }
}

/**
 * Gets the machine for this tab. If another tab has it, `ui.busy` is shown and: that tab lets go and this one starts,
 * or the user takes over (the other tab is told), or the user asks for a guest session and this resolves to
 * `'guest'`. Rejects only when the platform refuses locks.
 */
export async function claimMachine(locks: LockManager, store: string, ui: MachineBusyUi): Promise<MachineLock | 'guest'> {
  const free = await acquireMachineLock(locks, store)
  if (free) return free

  const waiting = new AbortController()
  let notice: { close(): void } | undefined
  try {
    return await new Promise<MachineLock | 'guest'>((resolve, reject) => {
      notice = ui.busy(() => { waiting.abort(); stealMachineLock(locks, store).then(resolve, reject) }, () => { waiting.abort(); resolve('guest') })
      waitForMachineLock(locks, store, waiting.signal).then(lock => { if (lock) resolve(lock) }, error => {
        if ((error as { name?: string })?.name !== 'AbortError') reject(error)
      })
    })
  } finally {
    notice?.close()
  }
}
