import { Connection, FsError, FsShareChannel, MessageStream, PeerError, PromisesExport, serveFs } from '@ecmaos/peer'
import type { PromisesLike } from '@ecmaos/peer'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Outcome, OutcomeLine } from './outcome.ts'
import { dialPeer, parseRemoteSource, RemoteMountFailure } from './remote-mount.ts'
import type { DialOptions } from './remote-mount.ts'

/** A directory of this machine offered to another one, which mounts it */
export interface Share {
  name: string
  path: string
  readOnly: boolean
  host: string
  connection: Connection
}

const shares = new WeakMap<Kernel, Map<string, Share>>()
const registry = (kernel: Kernel) => { let map = shares.get(kernel); if (!map) shares.set(kernel, map = new Map()); return map }

export const shareNamePattern = /^[A-Za-z0-9._-]{1,64}$/

export interface ShareOptions extends DialOptions {
  /** The directory of this machine to offer */
  path: string
  /** The name it has on the other machine, which mounts it at /mnt/NAME */
  name: string
  readOnly: boolean
}

/**
 * Logs in to another ecmaOS machine and offers it a directory of this one. That machine mounts it (as `/mnt/<name>`, if it lets
 * you: only root may share to it) and reads and writes it through the link, answered from here. The link stays up until
 * `stopShare`, or until either side ends it.
 */
export async function startShare(kernel: Kernel, shell: Shell, options: ShareOptions): Promise<Share> {
  const fs = kernel.filesystem.fs
  if (!shareNamePattern.test(options.name)) throw new RemoteMountFailure('a share name may only hold letters, digits, dots, dashes and underscores')
  if (registry(kernel).has(options.name)) throw new RemoteMountFailure(`${options.name} is already shared`)
  const root = options.path.replace(/\/+$/, '')
  if (!(await fs.stat(root || '/')).isDirectory()) throw new RemoteMountFailure(`${options.path} is not a directory`)

  const connection = await dialPeer(kernel, shell, options)
  try {
    const channel = await connection.open(FsShareChannel, { params: { name: options.name, readOnly: options.readOnly }, timeout: 60_000 })
    serveFs(new MessageStream(channel), new PromisesExport(fs as unknown as PromisesLike, { root }), {
      readOnly: options.readOnly,
      onError: (op, where, error) => kernel.log.debug(`share ${options.name}: ${op} ${where ?? ''} failed: ${(error as { code?: string })?.code ?? error}`)
    })
    const share: Share = { name: options.name, path: options.path, readOnly: options.readOnly, host: `${options.source.host}:${options.source.port}`, connection }
    registry(kernel).set(options.name, share)
    const forget = () => { if (registry(kernel).get(options.name) === share) registry(kernel).delete(options.name); connection.close() }
    void channel.done.then(forget)
    void connection.done.then(forget)
    return share
  } catch (error) {
    connection.close()
    throw error
  }
}

export function listShares(kernel: Kernel): Share[] { return [...registry(kernel).values()] }

export function stopShare(kernel: Kernel, name: string): boolean {
  const share = registry(kernel).get(name)
  if (!share) return false
  registry(kernel).delete(name)
  share.connection.close()
  return true
}

export type ShareRequest =
  | { action: 'list' }
  | { action: 'stop', name: string }
  | { action: 'start', target: string, path: string, name: string, readOnly: boolean, cwd: string, options: Record<string, string> }

/** `share`: what the command asks for, as lines to print and an exit code */
export async function manageShare(kernel: Kernel, shell: Shell, request: ShareRequest): Promise<Outcome> {
  const lines: OutcomeLine[] = []
  const out = (text: string) => lines.push({ stream: 'out', text })
  const err = (text: string) => lines.push({ stream: 'err', text })

  if (request.action === 'list') {
    const all = listShares(kernel)
    if (all.length === 0) out('Nothing is shared.')
    for (const share of all) out(`${share.name.padEnd(20)} ${share.path.padEnd(30)} to ${share.host}${share.readOnly ? ' (read-only)' : ''}`)
    return { code: 0, lines }
  }
  if (request.action === 'stop') {
    if (!stopShare(kernel, request.name)) { err(`share: ${request.name} is not shared`); return { code: 1, lines } }
    out(`Stopped sharing ${request.name}`)
    return { code: 0, lines }
  }

  try {
    const source = parseRemoteSource(request.target, shell.env.get('USER') || 'root')
    if (!source) throw new RemoteMountFailure('the machine is [user@]host[:port]')
    const options = request.options
    if (!options['password']) throw new RemoteMountFailure('a password is needed to unlock your key')
    const path = request.path.startsWith('/') ? request.path : `${request.cwd.replace(/\/$/, '')}/${request.path}`
    const share = await startShare(kernel, shell, {
      source,
      password: options['password'],
      pairingCode: options['pair'],
      fingerprint: options['fingerprint'],
      acceptNew: options['accept-new'] === 'yes' || options['accept-new'] === 'true',
      path,
      name: request.name,
      readOnly: request.readOnly
    })
    out(`Sharing ${share.path} with ${share.host} as ${share.name}${share.readOnly ? ' (read-only)' : ''}`)
    return { code: 0, lines }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const known = error instanceof RemoteMountFailure || error instanceof PeerError || error instanceof FsError || (error instanceof Error && 'code' in error)
    err(`share: ${known ? message : `failed: ${message}`}`)
    return { code: 1, lines }
  }
}
