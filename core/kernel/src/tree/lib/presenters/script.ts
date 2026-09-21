import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

/**
 * `load FILE`: runs a JavaScript file in the page's global scope, which is what the command is for
 * (a loaded script reaches `document`, `window`, `ecmaos`). Read through the calling user's shell
 * filesystem context so permissions apply, exactly as the in-process command did.
 */
export async function presentScript(_kernel: Kernel, _proc: unknown, params: Record<string, unknown>, shell?: Shell): Promise<void> {
  const path = params['path']
  if (typeof path !== 'string' || !path) throw new Error('missing path')
  if (!shell) throw new Error('no shell')

  const code = await shell.context.fs.promises.readFile(path, 'utf-8')
  const script = new Function(code)
  script()
}
