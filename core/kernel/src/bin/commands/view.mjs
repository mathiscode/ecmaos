/**
 * Real `execve`'d `view` -- migrated off `Kernel`'s legacy in-process shim (`core/utils/src/commands/
 * view.ts`). Parses the options and checks each file exists; showing it (PDF, markdown, JSON,
 * image, audio or video, each in its own window) is the `document` presenter
 * (`#lib/presenters/document.ts`), reached through `window_present`, which hands back the status
 * lines the command used to print for this program to print in order.
 */

import { basename, resolvePath } from './lib/paths.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat } = syscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text + '\n'))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: view [OPTIONS] [FILE...]
View files in a new window. Supports PDF, markdown, JSON, images, audio, and video files.

  --help                   display this help and exit
  
Audio/Video Options (for audio and video files):
  --no-autoplay            don't start playing automatically
  --loop                   loop the media
  --muted                  start muted
  --volume <0-100>         set volume (0-100, default: 100, audio only)
  --no-controls            hide video controls (video only)
  --fullscreen             open in fullscreen mode (video only)
  --width <width>          set window width (video only)
  --height <height>        set window height (video only)
  --quiet                  play without opening a window (audio only, background playback)

Examples:
  view document.pdf                    view a PDF file
  view README.md                       view a markdown file
  view data.json                       view a JSON file
  view image.png                       view an image
  view song.mp3                        view/play an audio file
  view movie.mp4                       view/play a video file
  view --loop music.mp3                play audio in a loop
  view --no-autoplay video.mp4         load video without auto-playing
  view --volume 50 track.mp3           play at 50% volume
  view --fullscreen movie.mp4          play video in fullscreen mode`

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  const options = { autoplay: true, loop: false, muted: false, volume: 100, controls: true, fullscreen: false, quiet: false }
  const files = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-autoplay') {
      options.autoplay = false
    } else if (arg === '--loop') {
      options.loop = true
    } else if (arg === '--muted') {
      options.muted = true
    } else if (arg === '--quiet') {
      options.quiet = true
    } else if (arg === '--no-controls') {
      options.controls = false
    } else if (arg === '--fullscreen') {
      options.fullscreen = true
    } else if (arg === '--volume' && i + 1 < args.length) {
      const value = args[i + 1]
      if (!value) {
        err('view: missing volume value')
        return 1
      }
      const volume = parseFloat(value)
      if (isNaN(volume) || volume < 0 || volume > 100) {
        err(`view: invalid volume: ${value} (must be 0-100)`)
        return 1
      }
      options.volume = volume
      i++
    } else if ((arg === '--width' || arg === '--height') && i + 1 < args.length) {
      const name = arg.slice(2)
      const value = args[i + 1]
      if (!value) {
        err(`view: missing ${name} value`)
        return 1
      }
      const size = parseInt(value, 10)
      if (isNaN(size) || size <= 0) {
        err(`view: invalid ${name}: ${value}`)
        return 1
      }
      options[name] = size
      i++
    } else if (arg && !arg.startsWith('--')) {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    err('view: missing file argument')
    err("Try 'view --help' for more information.")
    return 1
  }

  for (const file of files) {
    const fullPath = resolvePath(getcwd(), file)

    try {
      stat(fullPath)
    } catch {
      err(`view: file not found: ${fullPath}`)
      continue
    }

    try {
      const windowTitle = files.length > 1 ? `${basename(file)} (${files.indexOf(file) + 1}/${files.length})` : basename(file)
      const { result } = await present(syscalls, 'document', { path: fullPath, file, windowTitle, options })
      for (const message of result.messages) (message.stream === 'err' ? err : out)(message.text)
    } catch (error) {
      err(`view: error viewing ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return 1
    }
  }

  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`view: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
