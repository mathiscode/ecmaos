/** Show a desktop notification through the browser. */

import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll } = syscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: notify-send [OPTION...] SUMMARY [BODY]
Show a notification. The browser asks for permission the first time.

  -a, --app-name=NAME   the sending application (shown with the summary when set)
  -i, --icon=URL        an icon to show
  -u, --urgency=LEVEL   low, normal or critical (accepted and ignored: the browser decides)
  -t, --expire-time=MS  accepted and ignored: the browser decides
  -h, -c, -e, -r        accepted and ignored
  --help                display this help and exit`

async function main() {
  const args = argv.slice(1)
  const words = []
  let app
  let icon
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = () => arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i]
    if (arg === '--help') { err(usage); return 0 }
    else if (arg === '-a' || arg.startsWith('--app-name')) app = value()
    else if (arg === '-i' || arg.startsWith('--icon')) icon = value()
    else if (arg === '-u' || arg.startsWith('--urgency')) {
      const level = value()
      if (!['low', 'normal', 'critical'].includes(level)) { err(`notify-send: unknown urgency '${level}'`); return 1 }
    } else if (arg === '-t' || arg.startsWith('--expire-time') || arg === '-h' || arg === '-c' || arg === '-e' || arg === '-r' || arg === '-p') i++
    else if (arg === '--') { words.push(...args.slice(i + 1)); break }
    else if (arg.startsWith('-') && arg.length > 1) { err(`notify-send: unknown option '${arg}'`); return 1 }
    else words.push(arg)
  }

  if (words.length === 0) { err('notify-send: no summary given'); err("Try 'notify-send --help' for more information."); return 1 }
  const [summary, ...body] = words
  try {
    await present(syscalls, 'notify', { title: app ? `${app}: ${summary}` : summary, body: body.join(' ') || undefined, icon })
  } catch (error) {
    err(`notify-send: ${error.message}`)
    return 1
  }
  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`notify-send: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
