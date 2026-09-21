/**
 * Real `execve`'d `play` -- migrated off `Kernel`'s legacy in-process shim (`core/utils/src/
 * commands/play.ts`). Parses options and checks each file; the `<audio>` element and its player
 * window (or, with `--quiet`, none) are the `audio` presenter (`#lib/presenters/media.ts`), reached
 * through `window_present`. The command returns once playback has started, as before.
 */

import { basename, resolvePath } from './lib/paths.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, writeAll, getcwd, stat } = syscalls

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text + '\n'))
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: play [OPTIONS] [FILE...]
Play an audio file.

  --help                   display this help and exit
  --no-autoplay            don't start playing automatically
  --loop                   loop the audio
  --muted                  start muted
  --volume <0-100>         set volume (0-100, default: 100)
  --quiet                  play without opening a window (background playback)

Examples:
  play song.mp3                    play an audio file
  play --loop music.mp3           play audio in a loop
  play --no-autoplay audio.mp3    load audio without auto-playing
  play --volume 50 track.mp3      play at 50% volume
  play --quiet background.mp3      play audio in background
  play song1.mp3 song2.mp3        play multiple audio files`

function formatDuration(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '?:??'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  const options = { autoplay: true, loop: false, muted: false, volume: 100, quiet: false }
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
    } else if (arg === '--volume' && i + 1 < args.length) {
      const value = args[i + 1]
      if (!value) {
        err('play: missing volume value')
        return 1
      }
      const volume = parseFloat(value)
      if (isNaN(volume) || volume < 0 || volume > 100) {
        err(`play: invalid volume: ${value} (must be 0-100)`)
        return 1
      }
      options.volume = volume
      i++
    } else if (arg && !arg.startsWith('--')) {
      files.push(arg)
    }
  }

  if (files.length === 0) {
    err('play: missing file argument')
    err("Try 'play --help' for more information.")
    return 1
  }

  for (const file of files) {
    const fullPath = resolvePath(getcwd(), file)

    try {
      stat(fullPath)
    } catch {
      err(`play: file not found: ${fullPath}`)
      continue
    }

    try {
      out(`Loading audio: ${file}...`)
      const name = basename(file)
      const title = files.length > 1 ? `${name} (${files.indexOf(file) + 1}/${files.length})` : name
      const { result } = await present(syscalls, 'audio', { path: fullPath, title, name, label: file, options })

      if (result.metadataFailed) err(`play: warning: could not load metadata for ${file}`)

      const where = result.quiet ? 'Playing in background' : 'Playing'
      out(result.duration > 0 ? `${where}: ${file} (${formatDuration(result.duration)})` : `${where}: ${file}`)
    } catch (error) {
      err(`play: error playing ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return 1
    }
  }

  return 0
}

try {
  exit(await main())
} catch (error) {
  err(`play: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
