/**
 * What `insmod`, `rmmod` and `modinfo` ask of the kernel. The programs parse their arguments; this does the work
 * and returns the lines to print and an exit code, as `mountFilesystem` does for `mount`.
 */

import { Cap, capable, modules as loadedModules } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'

import type { Kernel } from '#kernel.ts'
import { ModuleError, parseModinfo } from './kmodule.ts'

export type ModuleRequest =
  | { action: 'load', path: string, params: string[], force: boolean }
  | { action: 'unload', name: string, force: boolean }
  | { action: 'info', target: string }

export interface ModuleResult {
  code: number
  lines: Array<{ stream: 'out' | 'err', text: string }>
}

const fail = (command: string, error: unknown): ModuleResult => {
  const message = error instanceof ModuleError || error instanceof Error ? error.message : String(error)
  return { code: 1, lines: [{ stream: 'err', text: `${command}: ${message}` }] }
}

const done = (...text: string[]): ModuleResult => ({ code: 0, lines: text.map(line => ({ stream: 'out' as const, text: line })) })

export async function moduleControl(kernel: Kernel, proc: Process, request: ModuleRequest): Promise<ModuleResult> {
  const kmodules = kernel.kmodules

  if (request.action === 'info') {
    try {
      const mod = loadedModules.get(request.target)
      const info = mod ? kmodules.info(mod.name) : parseModinfo(await kernel.filesystem.fs.readFile(request.target, 'utf8'))
      if (!info) return fail('modinfo', new ModuleError('ENOENT', `module ${request.target} not found`))
      const lines = [`name:           ${info.name}`]
      if (info.version) lines.push(`version:        ${info.version}`)
      for (const author of info.author ?? []) lines.push(`author:         ${author}`)
      if (info.description) lines.push(`description:    ${info.description}`)
      if (info.license) lines.push(`license:        ${info.license}`)
      lines.push('kind:           js (runs in the kernel, unconfined)')
      if (info.kernelApi) lines.push(`kernel_api:     ${info.kernelApi}`)
      if (info.depends.length) lines.push(`depends:        ${info.depends.join(',')}`)
      for (const alias of info.alias) lines.push(`alias:          ${alias}`)
      for (const parm of info.parm) lines.push(`parm:           ${parm.name}:${parm.description} (${parm.type})`)
      return done(...lines)
    } catch (error) {
      return fail('modinfo', error)
    }
  }

  if (!capable(proc, Cap.SYS_MODULE)) return fail(request.action === 'load' ? 'insmod' : 'rmmod', 'Operation not permitted')

  if (request.action === 'load') {
    try {
      const source = await kernel.filesystem.fs.readFile(request.path, 'utf8')
      await kmodules.load(source, { force: request.force, params: request.params })
      return done()
    } catch (error) {
      return fail('insmod', error)
    }
  }

  try {
    await kmodules.unload(request.name, request.force)
    return done()
  } catch (error) {
    return fail('rmmod', error)
  }
}
