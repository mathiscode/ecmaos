import { createTarPacker } from 'modern-tar'
import pako from 'pako'

/** An npm tarball (`package/<name>` entries, gzipped) of `files`, as a registry serves it */
export async function buildNpmTarballGzip(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const { readable, controller } = createTarPacker()
  const chunks: Uint8Array[] = []
  const readerDone = (async () => {
    const reader = readable.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  })()

  for (const [name, content] of Object.entries(files)) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const entryStream = controller.add({ name: `package/${name}`, type: 'file', size: bytes.length })
    const writer = entryStream.getWriter()
    await writer.write(bytes)
    await writer.close()
  }
  controller.finalize()
  await readerDone

  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const tarBytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { tarBytes.set(chunk, offset); offset += chunk.length }

  return pako.gzip(tarBytes)
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function sha512Sri(bytes: Uint8Array): Promise<string> {
  return `sha512-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', bytes as BufferSource))))}`
}
