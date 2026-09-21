/**
 * Real `execve`'d `web` -- migrated off `Kernel`'s legacy in-process shim (`core/utils/src/commands/
 * web.ts`). Parses and validates the URL here; the contained browser window itself (an iframe, a
 * URL bar, history) is the `browser` presenter (`#lib/presenters/browser.ts`), reached through
 * `window_present`. The command returns once the window is open, as before.
 */

import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll } = syscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: web [OPTIONS] [URL]
Open a URL in a new contained window.
Many sites will block the COR, so this is mostly useful for local/bespoke/credentialless resources.
To open in a new tab/browser window, use the 'open' command instead.

  --help                               display this help and exit
  --no-navbar                          hide the navigation bar

Examples:
  web https://example.com              open a URL in a browser window
  web --no-navbar https://example.com  open a URL without navigation bar
  web example.com                      open a URL (https:// will be prepended)
  web http://example.com               open a URL with http protocol`

function normalizeUrl(url) {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url) ? url : `https://${url}`
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  let hideNavbar = false
  const urlArgs = []

  for (const arg of args) {
    const trimmedArg = arg.trim()
    if (trimmedArg === '--no-navbar' || trimmedArg === '--hide-navbar') {
      hideNavbar = true
    } else if (trimmedArg && trimmedArg !== '--help' && trimmedArg !== '-h') {
      // A flag prefix may have been concatenated onto the URL
      let cleanArg = trimmedArg
      if (cleanArg.startsWith('--no-navbar')) {
        cleanArg = cleanArg.replace(/^--no-navbar/, '').trim()
        hideNavbar = true
      } else if (cleanArg.startsWith('--hide-navbar')) {
        cleanArg = cleanArg.replace(/^--hide-navbar/, '').trim()
        hideNavbar = true
      }
      if (cleanArg) urlArgs.push(cleanArg)
    }
  }

  if (urlArgs.length === 0) {
    err('web: missing URL argument')
    err("Try 'web --help' for more information.")
    return 1
  }

  const urlString = urlArgs.join(' ').trim()
  if (!urlString) {
    err('web: missing URL argument')
    return 1
  }

  const url = normalizeUrl(urlString)

  try {
    new URL(url)
  } catch {
    err(`web: invalid URL: ${urlString}`)
    return 1
  }

  try {
    await present(syscalls, 'browser', { url, hideNavbar })
    return 0
  } catch (error) {
    err(`web: ${error instanceof Error ? error.message : 'Unknown error'}`)
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`web: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
