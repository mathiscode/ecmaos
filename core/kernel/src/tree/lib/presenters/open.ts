import type { Kernel } from '#kernel.ts'

/** Opens `url` in a new browser tab (`open https://...`). */
export function presentExternal(_kernel: Kernel, _proc: unknown, params: Record<string, unknown>): void {
  const url = params['url']
  if (typeof url !== 'string' || !url) throw new Error('missing url')
  window.open(url, '_blank')
}

/** Hands the file at `path` to the browser as a download (`open file.txt`). */
export async function presentDownload(kernel: Kernel, _proc: unknown, params: Record<string, unknown>): Promise<void> {
  const path = params['path']
  if (typeof path !== 'string' || !path) throw new Error('missing path')

  const file = await kernel.filesystem.fs.readFile(path)
  const blob = new Blob([new Uint8Array(file)], { type: 'application/octet-stream' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = path.split('/').pop() || 'download'
  a.click()
  window.URL.revokeObjectURL(url)
}
