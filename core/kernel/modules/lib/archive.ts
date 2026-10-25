import type { FilesystemRequest } from '@ecmaos/types'

const isUrl = (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)

/** An archive type (`zip`, `iso`) reads its source whole, and says so */
export async function readArchive(request: FilesystemRequest, label: string): Promise<Uint8Array> {
  request.out(isUrl(request.source) ? `Fetching ${label} from ${request.source}...` : `Reading ${label} from ${request.source}...`)
  return request.read(request.source)
}
