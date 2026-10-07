import { promises as fs } from 'node:fs'
import path from 'node:path'

import { FsError, PromisesExport } from '@ecmaos/peer'
import type { ExportFs, PromisesLike } from '@ecmaos/peer'

/** A host directory offered to the machines that log in */
export interface ExportSpec {
  name: string
  dir: string
  /** Read-only unless the export was given `:rw` */
  readOnly: boolean
}

/** `NAME=DIR`, `DIR` (named after its last part), either with `:rw` or `:ro` at the end; read-only by default */
export function parseExport(argument: string): ExportSpec {
  let text = argument
  let readOnly = true
  if (text.endsWith(':rw')) { readOnly = false; text = text.slice(0, -3) } else if (text.endsWith(':ro')) text = text.slice(0, -3)
  const equals = text.indexOf('=')
  const named = equals > 0 && !/^[A-Za-z]:[\\/]/.test(text) ? text.slice(0, equals) : undefined
  const dir = path.resolve(named ? text.slice(equals + 1) : text)
  const name = named ?? (path.basename(dir) || 'root')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`export name '${name}' may only hold letters, digits, dots, dashes and underscores`)
  return { name, dir, readOnly }
}

/**
 * Opens a host directory as an export. Everything is confined to the directory: a path is resolved against its real location
 * and refused if a symbolic link on the way leads out of it. (The check and the use are two steps, so something else on the
 * host replacing a directory with a link between them could slip through; do not export a directory others can rearrange.)
 */
export async function openExport(spec: ExportSpec): Promise<ExportFs> {
  const root = await fs.realpath(spec.dir)
  if (!(await fs.stat(root)).isDirectory()) throw new Error(`${spec.dir} is not a directory`)
  return new PromisesExport(fs as unknown as PromisesLike, {
    root,
    async confine(full) {
      if (full === root) return
      let parent: string
      try { parent = await fs.realpath(path.dirname(full)) } catch (error) { throw new FsError((error as { code?: string }).code ?? 'ENOENT') }
      if (parent !== root && !parent.startsWith(root + path.sep)) throw new FsError('EACCES', 'outside the export')
    }
  })
}
