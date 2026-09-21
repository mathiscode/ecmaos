/**
 * Real `execve`'d `video` -- migrated off `Kernel`'s legacy in-process shim (`core/utils/src/
 * commands/video.ts`). This parses the options and checks each file exists; the window, the
 * `<video>` element and its sizing are the `video` presenter (`#lib/presenters/media.ts`), reached
 * through `window_present`. As before, the command returns once the window is up and the video keeps
 * playing. (The original's `chalk` colouring is dropped, like every other migrated coreutil's.)
 */

import { basename, resolvePath } from './lib/paths.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat } = syscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text + '\n'))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: video [OPTIONS] [FILE...]
Play a video file in a window.

  --help                   display this help and exit
  --no-autoplay            don't start playing automatically
  --no-controls            hide video controls
  --loop                   loop the video
  --muted                  start muted
  --fullscreen             open in fullscreen mode
  --width <width>          set window width (default: video width or screen width)
  --height <height>        set window height (default: video height or screen height)

Examples:
  video movie.mp4                    play a video file
  video --loop clip.mp4             play a video in a loop
  video --no-autoplay video.mp4     load video without auto-playing
  video --fullscreen movie.mp4      play video in fullscreen mode
  video video1.mp4 video2.mp4       play multiple videos`

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  const options = { autoplay: true, controls: true, loop: false, muted: false, fullscreen: false }
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-autoplay') {
      options.autoplay = false
    } else if (arg === '--no-controls') {
      options.controls = false
    } else if (arg === '--loop') {
      options.loop = true
    } else if (arg === '--muted') {
      options.muted = true
    } else if (arg === '--fullscreen') {
      options.fullscreen = true
    } else if ((arg === '--width' || arg === '--height') && i + 1 < args.length) {
      const name = arg.slice(2)
      const value = args[i + 1]
      const size = parseInt(value, 10)
      if (!value) {
        err(`video: missing ${name} value`)
        return 1
      }
      if (isNaN(size) || size <= 0) {
        err(`video: invalid ${name}: ${value}`)
        return 1
      }
      options[name] = size
      i++
    } else if (arg && !arg.startsWith('--')) {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    err('video: missing file argument')
    err("Try 'video --help' for more information.")
    return 1
  }

  for (const file of files) {
    const fullPath = resolvePath(getcwd(), file)

    try {
      stat(fullPath)
    } catch {
      err(`video: file not found: ${fullPath}`)
      continue
    }

    try {
      out(`Loading video: ${file}...`)
      const title = files.length > 1 ? `${basename(file)} (${files.indexOf(file) + 1}/${files.length})` : basename(file)
      const { result } = await present(syscalls, 'video', { path: fullPath, title, options })

      if (result.metadataFailed) err(`video: warning: could not load metadata for ${file}, using default size`)

      if (result.duration > 0) {
        const minutes = Math.floor(result.duration / 60)
        const seconds = Math.floor(result.duration % 60)
        out(`Playing: ${file} (${minutes}:${seconds.toString().padStart(2, '0')})`)
      } else {
        out(`Playing: ${file}`)
      }
    } catch (error) {
      err(`video: error playing ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return 1
    }
  }

  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`video: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
