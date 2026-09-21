import path from 'path'
import { Fetch, InMemory, resolveMountConfig, SingleBuffer } from '@zenfs/core'
import { IndexedDB, WebStorage, WebAccess } from '@zenfs/dom'
import { Iso, Zip } from '@zenfs/archives'
import { Dropbox, GoogleDrive } from '@zenfs/cloud'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Outcome, OutcomeLine } from './outcome.ts'

/**
 * Everything `mount` needs that only the main thread has: the live `kernel.filesystem` mount table, the
 * browser storage/File System Access APIs, and Google's OAuth scripts (injected into `document.head`).
 * The `mount` program itself (`bin/commands/mount.mjs`) is a thin argument parser that reaches this
 * through the `fs_mount` syscall; the backend logic below is the original `mount` command body, moved
 * rather than rewritten.
 *
 * Results come back as lines for the program to print (`{ stream, text }`) plus an exit code, since a
 * syscall can only return a number and the messages are the whole user-visible output.
 */

export interface MountRequest {
  type: string
  source: string
  /** Resolved against `cwd` */
  target: string
  cwd: string
  options: Record<string, string>
  /** False for `/etc/fstab` processing: backends needing a picker or OAuth sign-in are skipped */
  interactive: boolean
}


/** A failure with a message ready to show as `mount: <message>`; anything else is wrapped as "failed to mount filesystem" */
class MountFailure extends Error {}

const NO_SOURCE_TYPES = ['memory', 'singlebuffer', 'webstorage', 'webaccess', 'opfs', 'xml', 'dropbox', 'googledrive']
const isUrl = (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)

export function listMounts(kernel: Kernel): Array<{ target: string, name: string }> {
  return Array.from(kernel.filesystem.mounts.entries()).map(([target, mount]: [string, unknown]) => {
    const mountObj = mount as { store?: { constructor?: { name?: string } }, constructor?: { name?: string }, metadata?: () => { name?: string } }
    const backendName = mountObj.store?.constructor?.name || mountObj.constructor?.name || 'Unknown'
    return { target, name: mountObj.metadata?.()?.name || backendName }
  })
}

export async function mountFilesystem(kernel: Kernel, shell: Shell, request: MountRequest): Promise<Outcome> {
  const lines: OutcomeLine[] = []
  const out = (text: string) => lines.push({ stream: 'out', text })
  const err = (text: string) => lines.push({ stream: 'err', text })

  const type = request.type.toLowerCase()
  const source = request.source
  const target = path.resolve(request.cwd, request.target)
  const mountOptions = request.options
  const fs = shell.context.fs.promises

  try {
    if (!request.interactive && (type === 'webaccess' || type === 'googledrive')) {
      const reason = type === 'webaccess' ? 'webaccess requires interactive directory selection' : 'googledrive requires interactive authentication'
      throw new MountFailure(`skipping ${target}: ${reason}`)
    }

    const parentDir = path.dirname(target)
    if (parentDir !== target && !(await fs.exists(parentDir))) await fs.mkdir(parentDir, { recursive: true })
    if (!(await fs.exists(target))) await fs.mkdir(target, { recursive: true })

    const mount = async (config: unknown) => {
      await kernel.filesystem.fsSync.mount(target, await resolveMountConfig(config as never))
    }

    switch (type) {
      case 'fetch': {
        let baseUrl = mountOptions.baseUrl || ''
        let indexUrl: string
        if (source && isUrl(source)) {
          indexUrl = source
        } else {
          if (!baseUrl) throw new MountFailure('fetch filesystem requires either a full URL as source or baseUrl option')
          baseUrl = new URL(baseUrl).toString()
          indexUrl = new URL(source || 'index.json', baseUrl).toString()
        }
        await mount({ backend: Fetch, index: indexUrl, baseUrl, disableAsyncCache: true })
        break
      }
      case 'indexeddb':
        await mount({ backend: IndexedDB, storeName: source || target })
        break
      case 'webstorage': {
        const storageType = mountOptions.storage?.toLowerCase() || 'localstorage'
        let storage: Storage
        if (storageType === 'sessionstorage') {
          if (typeof sessionStorage === 'undefined') throw new MountFailure('sessionStorage is not available in this environment')
          storage = sessionStorage
        } else if (storageType === 'localstorage') {
          if (typeof localStorage === 'undefined') throw new MountFailure('localStorage is not available in this environment')
          storage = localStorage
        } else {
          throw new MountFailure(`invalid storage type '${storageType}'. Use 'localStorage' or 'sessionStorage'`)
        }
        await mount({ backend: WebStorage, storage })
        break
      }
      case 'webaccess': {
        const win = (typeof window === 'undefined' ? undefined : window) as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> } | undefined
        if (!win?.showDirectoryPicker) throw new MountFailure('File System Access API is not available in this environment')
        let handle: FileSystemDirectoryHandle
        try {
          handle = await win.showDirectoryPicker()
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw new MountFailure('directory selection cancelled')
          throw error
        }
        await mount({ backend: WebAccess, handle })
        break
      }
      case 'opfs': {
        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) throw new MountFailure('Origin Private File System is not available in this environment')
        await mount({ backend: WebAccess, handle: await navigator.storage.getDirectory() })
        break
      }
      case 'memory':
        await mount({ backend: InMemory })
        break
      case 'singlebuffer': {
        const size = mountOptions.size ? parseInt(mountOptions.size, 10) : 1048576
        if (isNaN(size) || size <= 0) throw new MountFailure('invalid buffer size for singlebuffer type')
        let buffer: ArrayBuffer | SharedArrayBuffer
        try { buffer = new SharedArrayBuffer(size) } catch { buffer = new ArrayBuffer(size) }
        await mount({ backend: SingleBuffer, buffer })
        break
      }
      case 'zip':
      case 'iso': {
        const label = type === 'zip' ? 'archive' : 'ISO image'
        if (!source) throw new MountFailure(`${type} filesystem requires a source file or URL`)

        let data: Uint8Array
        if (isUrl(source)) {
          out(`Fetching ${label} from ${source}...`)
          const response = await fetch(source)
          if (!response.ok) throw new MountFailure(`failed to fetch ${label}: ${response.status} ${response.statusText}`)
          data = new Uint8Array(await response.arrayBuffer())
        } else {
          const sourcePath = path.resolve(request.cwd, source)
          if (!(await fs.exists(sourcePath))) throw new MountFailure(`${label === 'archive' ? 'archive' : 'ISO image'} file not found: ${sourcePath}`)
          out(`Reading ${label} from ${sourcePath}...`)
          data = new Uint8Array(await fs.readFile(sourcePath))
        }

        if (type === 'zip') await mount({ backend: Zip, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })
        else await mount({ backend: Iso, data })
        break
      }
      case 'dropbox': {
        if (!mountOptions.client) throw new MountFailure('dropbox filesystem requires client configuration\nUsage: mount -t dropbox TARGET -o client=\'{"accessToken":"..."}\'')

        let clientConfig: { accessToken: string, [key: string]: unknown }
        try { clientConfig = JSON.parse(mountOptions.client) } catch { throw new MountFailure('invalid JSON in client option') }
        if (!clientConfig.accessToken) throw new MountFailure('client configuration must include accessToken')

        try {
          const { Dropbox: DropboxClient } = await import('dropbox')
          const cacheTTL = mountOptions.cacheTTL ? parseInt(mountOptions.cacheTTL, 10) : undefined
          await mount({ backend: Dropbox, client: new DropboxClient(clientConfig), ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {}) })
        } catch (error) {
          throw new MountFailure(`failed to mount dropbox filesystem: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
        break
      }
      case 'googledrive':
        await mountGoogleDrive({ out, mountOptions, mount })
        break
      default:
        throw new MountFailure(`unknown filesystem type '${request.type}'\nSupported types: fetch, indexeddb, webstorage, webaccess, opfs, memory, singlebuffer, zip, iso, dropbox, googledrive`)
    }

    out(source && !NO_SOURCE_TYPES.includes(type) ? `Mounted ${request.type} filesystem from ${source} to ${target}` : `Mounted ${request.type} filesystem at ${target}`)
    return { code: 0, lines }
  } catch (error) {
    if (error instanceof MountFailure) {
      for (const [index, text] of error.message.split('\n').entries()) err(index === 0 ? `mount: ${text}` : text)
    } else if (error instanceof GoogleDriveFailure) {
      for (const text of error.lines) err(text)
    } else {
      err(`mount: failed to mount filesystem: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
    return { code: 1, lines }
  }
}

/** A Google Drive failure that already carries its full set of guidance lines */
class GoogleDriveFailure extends Error {
  constructor(readonly lines: string[]) { super(lines[0]) }
}

interface GoogleWindow {
  gapi?: {
    load?: (module: string, callback: () => void) => void
    client?: {
      init?: (config: { apiKey: string, discoveryDocs?: string[] }) => Promise<void>
      request?: (config: { path: string }) => Promise<unknown>
      setToken?: (token: { access_token: string }) => void
      drive?: unknown
    }
  }
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient: (config: { client_id: string, scope: string, callback: (response: { access_token: string }) => void }) => { requestAccessToken: () => void }
      }
    }
  }
}

const loadScript = (src: string, failure: string, extra?: (script: HTMLScriptElement) => void) => new Promise<void>((resolve, reject) => {
  const script = document.createElement('script')
  script.src = src
  extra?.(script)
  script.onload = () => resolve()
  script.onerror = () => reject(new Error(failure))
  document.head.appendChild(script)
})

const waitFor = async (condition: () => unknown, attempts = 50, interval = 100) => {
  for (let i = 0; i < attempts && !condition(); i++) await new Promise(resolve => setTimeout(resolve, interval))
}

/** Google Drive needs the browser's window: both SDK scripts are loaded here and the OAuth popup opens from here. */
async function mountGoogleDrive({ out, mountOptions, mount }: {
  out: (text: string) => void
  mountOptions: Record<string, string>
  mount: (config: unknown) => Promise<void>
}): Promise<void> {
  try {
    if (typeof window === 'undefined') throw new MountFailure('Google Drive API requires a browser environment')
    const win = window as unknown as GoogleWindow

    if (!win.google?.accounts) {
      out('Loading Google Identity Services library...')
      await loadScript('https://accounts.google.com/gsi/client', 'Failed to load Google Identity Services script', script => { script.async = true; script.defer = true })
    }
    await waitFor(() => win.google?.accounts)
    if (!win.google?.accounts) throw new MountFailure('Failed to load Google Identity Services library')

    if (!win.gapi) {
      out('Loading Google API client library...')
      await loadScript('https://apis.google.com/js/api.js', 'Failed to load Google API script')
    }
    await waitFor(() => win.gapi)
    if (!win.gapi) throw new MountFailure('Failed to load Google API client library')

    if (!win.gapi.client || !win.gapi.client.drive) {
      out('Initializing Google API client...')
      const initConfig = { apiKey: mountOptions.apiKey!, discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'] }

      await new Promise<void>((resolve, reject) => {
        if (!win.gapi?.load) return reject(new Error('gapi.load is not available'))
        win.gapi.load('client', () => {
          if (!win.gapi?.client?.init) return reject(new Error('gapi.client.init is not available'))
          win.gapi.client.init(initConfig)
            .then(() => {
              setTimeout(() => {
                if (win.gapi?.client?.drive) resolve()
                else reject(new Error('API discovery response missing required fields. The Drive API discovery document may have failed to load. This could be due to: network issues, invalid API key, or the Drive API not being enabled in your Google Cloud project.'))
              }, 1000)
            })
            .catch((error: Error & { error?: string, details?: string }) => {
              const errorMessage = JSON.stringify({ error: error.error, details: error.details }, null, 2)
              const lowerError = error.error?.toLowerCase()
              if (lowerError?.includes('discovery') || lowerError?.includes('API') || lowerError?.includes('required fields')) {
                reject(new Error(`API discovery failed: ${errorMessage}. This could be due to: network issues, invalid API key, or the Drive API not being enabled in your Google Cloud project.`))
              } else {
                reject(new Error(error.error || error.details || 'Unknown error'))
              }
            })
        })
      })

      if (!win.gapi?.client?.drive) {
        await new Promise<void>((resolve, reject) => {
          let attempts = 0
          const checkDrive = () => {
            if (win.gapi?.client?.drive) resolve()
            else if (attempts++ < 10) setTimeout(checkDrive, 200)
            else reject(new Error('Failed to load Drive API. The discovery document may have failed to load. Check the browser console for network errors (502 Bad Gateway suggests a network issue).'))
          }
          checkDrive()
        })
      }
    }

    if (!win.gapi?.client?.drive) {
      throw new GoogleDriveFailure([
        'mount: Google Drive API is not available',
        'Troubleshooting steps:',
        '  1. Check the browser console for network errors (502 Bad Gateway suggests a network/server issue)',
        '  2. Verify your API key is valid and has the Drive API enabled',
        '  3. Ensure the Drive API is enabled in your Google Cloud project',
        '  4. Check if there are any API key restrictions (HTTP referrers, IP addresses, etc.)',
        '  5. Try refreshing the page and mounting again'
      ])
    }

    if (mountOptions.clientId) {
      out('Checking authentication status...')
      const driveScope = mountOptions.scope || 'https://www.googleapis.com/auth/drive'

      try {
        await win.gapi.client.request?.({ path: 'https://www.googleapis.com/drive/v3/about?fields=user' })
      } catch {
        out('Authentication required. Please sign in to Google...')

        try {
          if (!win.google?.accounts?.oauth2) throw new Error('Google Identity Services OAuth2 is not available')
          await new Promise<void>((resolve, reject) => {
            const tokenClient = win.google?.accounts?.oauth2?.initTokenClient({
              client_id: mountOptions.clientId!,
              scope: driveScope,
              callback: (response: { access_token: string }) => {
                if (response.access_token && win.gapi?.client?.setToken) {
                  win.gapi.client.setToken({ access_token: response.access_token })
                  resolve()
                } else {
                  reject(new Error('Failed to obtain access token'))
                }
              }
            })
            tokenClient?.requestAccessToken()
          })
        } catch (authError) {
          const message = authError instanceof Error ? authError.message : String(authError)
          if (message.toLowerCase().includes('popup') || message.toLowerCase().includes('blocked')) {
            throw new Error(`OAuth authentication failed: ${message}. Please allow popups for this site.`)
          } else if (message.toLowerCase().includes('origin') || message.toLowerCase().includes('authorized')) {
            throw new Error(`OAuth authentication failed: ${message}. Your origin may not be authorized in Google Cloud Console. Add your current origin to the OAuth client's authorized JavaScript origins.`)
          }
          throw authError
        }
      }
    }

    const cacheTTL = mountOptions.cacheTTL ? parseInt(mountOptions.cacheTTL) : undefined
    await mount({ backend: GoogleDrive, drive: win.gapi.client.drive as never, disableAsyncCache: true, ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {}) })
  } catch (error) {
    if (error instanceof MountFailure || error instanceof GoogleDriveFailure) throw error
    throw new GoogleDriveFailure(describeDriveError(error))
  }
}

/** The message plus the guidance the original command printed for each common failure. */
function describeDriveError(error: unknown): string[] {
  let message: string
  if (error instanceof Error) {
    message = error.message || error.toString()
  } else if (typeof error === 'string') {
    message = error
  } else if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>
    message =
      (typeof err.message === 'string' ? err.message : '') ||
      (typeof err.error === 'string' ? err.error : '') ||
      (typeof err.details === 'string' ? err.details : '') ||
      (typeof err.reason === 'string' ? err.reason : '') ||
      (err.toString && typeof err.toString === 'function' ? err.toString() : '') ||
      JSON.stringify(error)
  } else {
    message = String(error)
  }

  const lines = [`mount: failed to mount googledrive filesystem: ${message}`]
  const lower = message.toLowerCase()

  if (lower.includes('popup') || lower.includes('blocked')) {
    lines.push('', 'OAuth popup was blocked. Common causes:', '  • Browser popup blocker is enabled', '  • Browser security restrictions', '', 'To fix this:', '  1. Allow popups for this site in your browser settings', '  2. Try the mount command again')
  } else if (lower.includes('origin') || lower.includes('authorized')) {
    lines.push('', 'OAuth authentication failed. Common causes:', '  • Your domain/origin is not authorized in Google Cloud Console', '  • Invalid or incorrect OAuth client ID', '', 'To fix this:', '  1. Go to Google Cloud Console > APIs & Services > Credentials', '  2. Find your OAuth 2.0 Client ID', '  3. Add your current origin to "Authorized JavaScript origins"', '     (e.g., http://localhost:30443 or your domain)', '  4. If you only need read-only access, try mounting without clientId:', '     mount -t googledrive /mnt/gdrive -o apiKey=YOUR_API_KEY')
  } else if (lower.includes('discovery') || lower.includes('api discovery') || lower.includes('required fields')) {
    lines.push('', 'The Drive API discovery document failed to load. Common causes:', '  • Network connectivity issues (check for 502 Bad Gateway in console)', '  • Invalid or restricted API key', '  • Drive API not enabled in Google Cloud project', '  • CORS or browser security restrictions', '', 'Check the browser console for detailed network error messages.')
  } else if (lower.includes('network') || lower.includes('fetch') || lower.includes('502') || lower.includes('bad gateway')) {
    lines.push('', "Network error detected. This may be a temporary issue with Google's servers.", '  • Wait a few moments and try again', '  • Check your internet connection', '  • Verify the API key is correct')
  }

  if (error && typeof error === 'object' && !(error instanceof Error)) {
    try {
      const details = JSON.stringify(error, null, 2)
      if (details !== '{}' && details.length < 500) lines.push('', `Error details:\n${details}`)
    } catch { /* not serializable */ }
  }

  if (error instanceof Error && error.stack && !lower.includes('discovery') && !lower.includes('network')) lines.push('', `Stack trace:\n${error.stack}`)
  return lines
}
