/**
 * What `insmod`, `rmmod` and `modinfo` ask of the kernel. The programs parse their arguments; this does the work
 * and returns the lines to print and an exit code, as `mountFilesystem` does for `mount`.
 */

import { Cap, capable, modules as loadedModules } from '@zenfs/linux'
import type { Process } from '@zenfs/linux'

import type { Kernel } from '#kernel.ts'
import { ModuleError, parseModinfo, readModuleFile } from './kmodule.ts'
import { isWasm } from './wasm-module.ts'
import { depmod } from './modprobe.ts'

export type ModuleRequest =
  | { action: 'load', path: string, params: string[], force: boolean }
  | { action: 'unload', name: string, force: boolean }
  | { action: 'info', target: string }
  | { action: 'depmod' }
  | { action: 'probe', name: string, remove: boolean, dryRun: boolean, verbose: boolean, ignoreCommands: boolean, params: string[] }

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
      const source = mod ? undefined : await readModuleFile(kernel.filesystem.fs, request.target)
      const info = source === undefined ? kmodules.info(mod!.name) : parseModinfo(source)
      if (!info) return fail('modinfo', new ModuleError('ENOENT', `module ${request.target} not found`))
      const signature = source === undefined ? kmodules.signature(mod!.name) : await kmodules.verify(source)
      const lines = [`name:           ${info.name}`]
      if (info.version) lines.push(`version:        ${info.version}`)
      for (const author of info.author ?? []) lines.push(`author:         ${author}`)
      if (info.description) lines.push(`description:    ${info.description}`)
      if (info.license) lines.push(`license:        ${info.license}`)
      const kind = source === undefined ? kmodules.kind(mod!.name) : isWasm(source) ? 'wasm' : 'js'
      lines.push(kind === 'wasm' ? 'kind:           wasm (a sandboxed component: it has only the world it declares)' : 'kind:           js (runs in the kernel, unconfined)')
      if (info.kernelApi) lines.push(`kernel_api:     ${info.kernelApi}`)
      if (info.depends.length) lines.push(`depends:        ${info.depends.join(',')}`)
      for (const alias of info.alias) lines.push(`alias:          ${alias}`)
      for (const parm of info.parm) lines.push(`parm:           ${parm.name}:${parm.description} (${parm.type})`)
      if (signature && signature.state !== 'none') {
        lines.push('sig_id:         Ed25519')
        if (signature.signer) lines.push(`signer:         ${signature.signer}`)
        if (signature.keyId) lines.push(`sig_key:        ${signature.keyId}`)
        lines.push(`sig_status:     ${signature.state === 'valid' ? `valid (trusted key ${signature.key})` : signature.state === 'bad' ? 'does not match' : 'no trusted key'}`)
      }
      return done(...lines)
    } catch (error) {
      return fail('modinfo', error)
    }
  }

  const command = { load: 'insmod', unload: 'rmmod', depmod: 'depmod', probe: 'modprobe' }[request.action]
  if (!capable(proc, Cap.SYS_MODULE)) return fail(command, 'Operation not permitted')

  if (request.action === 'depmod') {
    try {
      const { modules, warnings } = await depmod(kernel.filesystem.fs, kernel.modprobe.dir)
      return { code: 0, lines: warnings.map(text => ({ stream: 'err' as const, text: `depmod: WARNING: ${text}` })).concat(modules ? [] : [{ stream: 'err' as const, text: `depmod: no modules found in ${kernel.modprobe.dir}` }]) }
    } catch (error) {
      return fail('depmod', error)
    }
  }

  if (request.action === 'probe') {
    try {
      const options = { dryRun: request.dryRun, ignoreCommands: request.ignoreCommands, params: request.params }
      const lines = request.remove ? await kernel.modprobe.unload(request.name, options) : await kernel.modprobe.load(request.name, options)
      return done(...(request.dryRun || request.verbose ? lines : []))
    } catch (error) {
      return fail('modprobe', error)
    }
  }

  if (request.action === 'load') {
    try {
      const source = await readModuleFile(kernel.filesystem.fs, request.path)
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
