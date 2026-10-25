import { Dropbox, GoogleDrive } from '@zenfs/cloud'
import type { ModuleContext } from '@ecmaos/types'

/**
 * The `googledrive` filesystem type. Google Drive needs the browser's window: both SDK scripts are loaded here and the OAuth
 * popup opens from here, so `mount -t googledrive` skips it in `/etc/fstab`.
 */

/** A failure that already carries its full set of guidance lines */
class DriveFailure extends Error {
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
async function signIn({ out, mountOptions }: {
  out: (text: string) => void
  mountOptions: Record<string, string>
}): Promise<object> {
  try {
    if (typeof window === 'undefined') throw new DriveFailure(['mount: Google Drive API requires a browser environment'])
    const win = window as unknown as GoogleWindow

    if (!win.google?.accounts) {
      out('Loading Google Identity Services library...')
      await loadScript('https://accounts.google.com/gsi/client', 'Failed to load Google Identity Services script', script => { script.async = true; script.defer = true })
    }
    await waitFor(() => win.google?.accounts)
    if (!win.google?.accounts) throw new DriveFailure(['mount: ' + 'Failed to load Google Identity Services library'])

    if (!win.gapi) {
      out('Loading Google API client library...')
      await loadScript('https://apis.google.com/js/api.js', 'Failed to load Google API script')
    }
    await waitFor(() => win.gapi)
    if (!win.gapi) throw new DriveFailure(['mount: ' + 'Failed to load Google API client library'])

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
      throw new DriveFailure([
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
            throw new Error(`OAuth authentication failed: ${message}. Please allow popups for this site.`, { cause: authError })
          } else if (message.toLowerCase().includes('origin') || message.toLowerCase().includes('authorized')) {
            throw new Error(`OAuth authentication failed: ${message}. Your origin may not be authorized in Google Cloud Console. Add your current origin to the OAuth client's authorized JavaScript origins.`, { cause: authError })
          }
          throw authError
        }
      }
    }

    const cacheTTL = mountOptions.cacheTTL ? parseInt(mountOptions.cacheTTL) : undefined
    return { drive: win.gapi.client.drive as never, disableAsyncCache: true, ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {}) }
  } catch (error) {
    if (error instanceof DriveFailure) throw error
    throw new DriveFailure(describeDriveError(error))
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

function googledrive(ctx: ModuleContext) {
  ctx.filesystem({
    name: 'googledrive',
    backend: GoogleDrive,
    needsPerson: 'googledrive requires interactive authentication',
    async config(request) {
      try {
        return await signIn({ out: request.out, mountOptions: request.options })
      } catch (error) {
        // the lines already begin with `mount: `, which `fail` adds itself
        if (error instanceof DriveFailure) request.fail(error.lines.join('\n').replace(/^mount: /, ''))
        throw error
      }
    }
  })
}

function dropbox(ctx: ModuleContext) {
  ctx.filesystem({
    name: 'dropbox',
    backend: Dropbox,
    async config(request) {
      const { options } = request
      if (!options.client) request.fail('dropbox filesystem requires client configuration\nUsage: mount -t dropbox TARGET -o client=\'{"accessToken":"..."}\'')

      let clientConfig: { accessToken: string, [key: string]: unknown }
      try { clientConfig = JSON.parse(options.client!) } catch { return request.fail('invalid JSON in client option') }
      if (!clientConfig.accessToken) request.fail('client configuration must include accessToken')

      try {
        const { Dropbox: DropboxClient } = await import('dropbox')
        const cacheTTL = options.cacheTTL ? parseInt(options.cacheTTL, 10) : undefined
        return { client: new DropboxClient(clientConfig), ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {}) }
      } catch (error) {
        return request.fail(`failed to mount dropbox filesystem: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }
  })
}

export default {
  init(ctx: ModuleContext) {
    dropbox(ctx)
    googledrive(ctx)
  }
}
