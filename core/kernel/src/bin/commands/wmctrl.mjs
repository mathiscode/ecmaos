/** List and control the windows of the desktop. */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, custom } = syscalls

const usage = `Usage: wmctrl [-l] | [ACTION ID [ARGUMENT...]]
List the windows of your user, or act on one. root sees and controls every window.

  -l, list              list windows: id, state, owner pid, title
  -a, focus ID          raise and focus the window
  -c, close ID          close the window
  minimize ID           minimize the window
  maximize ID           maximize the window
  restore ID            restore the window
  fullscreen ID         make the window fullscreen
  move ID X Y           move the window
  resize ID WIDTH HEIGHT  resize the window
  title ID TEXT...      set the window's title
  --help                display this help and exit`

const aliases = { '-l': 'list', '-a': 'focus', '-c': 'close' }
const errors = { 2: 'no such window', 1: 'not permitted', 22: 'invalid action' }

const encoder = new TextEncoder()
const out = text => write(1, encoder.encode(text + '\n'))
const fail = text => { write(2, encoder.encode(`wmctrl: ${text}\n`)); return 1 }

async function main() {
  const args = argv.slice(1)
  if (args[0] === '--help' || args[0] === '-h') { out(usage); return 0 }
  const action = aliases[args[0] ?? '-l'] ?? args[0]

  if (action === 'list') {
    const path = scratchPath('wmctrl')
    await custom('window_list', path)
    const windows = JSON.parse(await readBackAndDelete(syscalls, path))
    for (const win of windows) out(`${String(win.id).padEnd(8)} ${win.state.padEnd(10)} ${String(win.owner.pid).padStart(4)}  ${win.title}`)
    return 0
  }

  const id = args[1]
  if (!id) return fail(`'${action}' needs a window ID. Try 'wmctrl --help'`)
  let a = 0
  let b = 0
  let text = ''
  if (action === 'move' || action === 'resize') {
    a = Number(args[2])
    b = Number(args[3])
    if (!Number.isFinite(a) || !Number.isFinite(b)) return fail(`'${action}' needs two numbers`)
  } else if (action === 'title') {
    text = args.slice(2).join(' ')
  }

  try {
    await custom('wm_control', id, action, a, b, text)
    return 0
  } catch (error) {
    const errno = error?.errno
    return fail(`${action} ${id}: ${errors[errno] ?? (error instanceof Error ? error.message : String(error))}`)
  }
}

try {
  exit(await main())
} catch (error) {
  write(2, encoder.encode(`wmctrl: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
