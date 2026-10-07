/** Why a connection or channel failed. Stable strings: they cross the wire in `close` frames. */
export type PeerErrorCode =
  | 'version'      // no protocol version in common
  | 'protocol'     // the other side broke the rules (malformed frame, credit overrun, unknown channel)
  | 'limit'        // a size or count limit was exceeded
  | 'unsupported'  // no handler for the channel kind
  | 'refused'      // a handler declined to open the channel
  | 'auth'         // not allowed (reserved for the layers above)
  | 'timeout'
  | 'closed'       // the channel or connection ended
  | 'internal'

const Codes: ReadonlySet<string> = new Set<PeerErrorCode>(['version', 'protocol', 'limit', 'unsupported', 'refused', 'auth', 'timeout', 'closed', 'internal'])

export class PeerError extends Error {
  readonly code: PeerErrorCode
  constructor(code: PeerErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options)
    this.name = 'PeerError'
    this.code = code
  }

  /** A code read off the wire is only trusted if it is one we know */
  static fromWire(code: unknown, message: unknown) {
    const known = typeof code === 'string' && Codes.has(code) ? code as PeerErrorCode : 'internal'
    return new PeerError(known, typeof message === 'string' ? message : undefined)
  }
}
