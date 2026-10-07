import { randomInt, timingSafeEqual } from 'node:crypto'

/** How long a code stays good, and how many wrong guesses burn it */
export const PairingLifetime = 10 * 60_000
export const PairingAttempts = 3

export interface Pairing {
  readonly code: string
  readonly user: string
  /** Checks a code for a user. A good one is used up at once; too many bad ones burn it. */
  redeem(user: string, code: string): boolean
  /** Whether the code can still be used */
  readonly live: boolean
}

/**
 * A single-use pairing code for one user: six digits, ten minutes, three wrong guesses. It lets a browser the owner is
 * sitting at enrol its key, once, over a connection whose host key the owner has just checked.
 */
export function createPairing(user: string, now: () => number = Date.now): Pairing {
  const code = `${String(randomInt(0, 1000)).padStart(3, '0')}-${String(randomInt(0, 1000)).padStart(3, '0')}`
  const expires = now() + PairingLifetime
  let failures = 0
  let used = false
  const live = () => !used && failures < PairingAttempts && now() < expires
  return {
    code,
    user,
    get live() { return live() },
    redeem(candidateUser, candidate) {
      if (!live()) return false
      const a = Buffer.from(candidate)
      const b = Buffer.from(code)
      const good = candidateUser === user && a.length === b.length && timingSafeEqual(a, b)
      if (!good) { failures++; return false }
      used = true
      return true
    }
  }
}
