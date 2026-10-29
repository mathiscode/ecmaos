import { Iso, Tar, Zip } from '@zenfs/archives'
import type { ModuleContext } from '@ecmaos/types'

import { readArchive } from '../lib/archive.ts'

/** A gzipped tarball (`.tar.gz`, `.tgz`) is unpacked first: the tar type reads a plain archive */
async function gunzipped(data: Uint8Array): Promise<Uint8Array> {
  if (data[0] !== 0x1f || data[1] !== 0x8b) return data
  const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close() } })
  const reader = input.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    length += value.length
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
  return out
}

/**
 * The tar backend as zenfs describes it, but for `data`, which is checked as an object, as the zip backend's is. Its
 * own check names `Uint8Array` as a class and, where that is not recognised as one, calls it without `new`, which throws.
 */
const TarBackend = { ...Tar, options: { ...Tar.options, data: { type: 'object', required: true } } } as typeof Tar

// one module for all three: they share the library, and it registers types that a second copy of it could not
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
      name: 'tar',
      backend: TarBackend,
      source: 'required',
      async config(request) {
        return { data: await gunzipped(await readArchive(request, 'tar archive')), name: request.source.split('/').pop() }
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
