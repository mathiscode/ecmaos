import { KernelEvents } from '@ecmaos/types'
import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Presented } from './index.ts'

interface UploadOutcome {
  uploaded: string[]
  errors: string[]
}

/**
 * `upload [DIRECTORY]`: the browser's file picker. Files are written through the calling user's
 * shell filesystem context, as before, and `closed` resolves once the dialog is finished (files
 * chosen and written, or cancelled) so the process lives exactly that long. A `^C` while the dialog
 * is open drops the input; the picker itself cannot be dismissed from script.
 */
export function presentUpload(kernel: Kernel, _proc: unknown, params: Record<string, unknown>, shell?: Shell): Presented {
  const directory = params['directory']
  if (typeof directory !== 'string' || !directory) throw new Error('missing directory')
  if (!shell) throw new Error('no shell')

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '*'
  input.multiple = true

  const closed = new Promise<UploadOutcome>(resolve => {
    const outcome: UploadOutcome = { uploaded: [], errors: [] }

    input.addEventListener('cancel', () => resolve(outcome))
    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? [])
      if (files.length === 0) outcome.errors.push('No file selected')

      for (const file of files) {
        try {
          const data = new Uint8Array(await file.arrayBuffer())
          const destination = `${directory.replace(/\/$/, '')}/${file.name}`
          await shell.context.fs.promises.writeFile(destination, data)
          kernel.events.dispatch(KernelEvents.UPLOAD, { file: file.name, path: destination })
          outcome.uploaded.push(file.name)
        } catch (error) {
          outcome.errors.push(`Failed to upload ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      }

      resolve(outcome)
    })
  })

  input.click()
  return { closed, dispose: () => input.remove() }
}
