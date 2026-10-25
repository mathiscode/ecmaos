import { Iso, Zip } from '@zenfs/archives'
import type { ModuleContext } from '@ecmaos/types'

import { readArchive } from '../lib/archive.ts'

// one module for both: they share the library, and it registers types that a second copy of it could not
export default {
  init(ctx: ModuleContext) {
    ctx.filesystem({
      name: 'zip',
      backend: Zip,
      source: 'required',
      async config(request) {
        const data = await readArchive(request, 'archive')
        return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
      }
    })
    ctx.filesystem({
      name: 'iso',
      backend: Iso,
      source: 'required',
      async config(request) {
        return { data: await readArchive(request, 'ISO image') }
      }
    })
  }
}
