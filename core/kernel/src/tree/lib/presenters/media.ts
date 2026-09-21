import type { Kernel } from '#kernel.ts'

import type { Presented } from './index.ts'

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp'
}

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.3gp': 'audio/3gpp',
  '.amr': 'audio/amr'
}

function mimeType(table: Record<string, string>, fallback: string, path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot >= 0 && table[path.slice(dot).toLowerCase()]) || fallback
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Blob URL for the file at `path`, typed so the browser can decode it. */
async function blobUrl(kernel: Kernel, path: string, type: string): Promise<string> {
  const data = await kernel.filesystem.fs.readFile(path)
  return URL.createObjectURL(new Blob([new Uint8Array(data)], { type }))
}

/** Waits for `element`'s metadata (10s at most). Rejects if the browser cannot decode it. */
function loadMetadata(element: HTMLMediaElement, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout loading ${what} metadata`)), 10000)
    element.onloadedmetadata = () => { clearTimeout(timeout); resolve() }
    element.onerror = () => { clearTimeout(timeout); reject(new Error(`Failed to load ${what} metadata`)) }
  })
}

const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`missing ${name}`)
  return value
}

/**
 * `video`: a window with a `<video>` in it, sized to the video (or to `width`/`height`, or the
 * screen with `fullscreen`). Result: `{ duration, metadataFailed }` so the program can report it.
 */
export async function presentVideo(kernel: Kernel, _proc: unknown, params: Record<string, unknown>): Promise<Presented> {
  const path = str(params['path'], 'path')
  const title = str(params['title'], 'title')
  const options = (params['options'] ?? {}) as { autoplay?: boolean, controls?: boolean, loop?: boolean, muted?: boolean, fullscreen?: boolean, width?: number, height?: number }

  const url = await blobUrl(kernel, path, mimeType(VIDEO_MIME, 'video/mp4', path))
  const videoElement = document.createElement('video')
  videoElement.src = url
  videoElement.preload = 'metadata'

  let videoWidth = 640
  let videoHeight = 360
  let duration = 0
  let metadataFailed = false

  try {
    await loadMetadata(videoElement, 'video')
    videoWidth = videoElement.videoWidth
    videoHeight = videoElement.videoHeight
    duration = videoElement.duration
  } catch {
    metadataFailed = true
  }

  const { innerWidth, innerHeight } = window
  let windowWidth: number
  let windowHeight: number

  if (options.fullscreen) {
    windowWidth = innerWidth
    windowHeight = innerHeight
  } else if (options.width && options.height) {
    windowWidth = options.width
    windowHeight = options.height
  } else if (options.width) {
    windowWidth = options.width
    windowHeight = Math.round((videoHeight / videoWidth) * windowWidth)
  } else if (options.height) {
    windowHeight = options.height
    windowWidth = Math.round((videoWidth / videoHeight) * windowHeight)
  } else {
    // Fit to the screen if the video is larger, otherwise use its own size
    const scale = Math.min(innerWidth / videoWidth, innerHeight / videoHeight, 1)
    windowWidth = Math.round(videoWidth * scale)
    windowHeight = Math.round(videoHeight * scale)
  }

  windowWidth = Math.max(windowWidth, 320)
  windowHeight = Math.max(windowHeight, 180)

  const attrs: string[] = []
  if (options.autoplay) attrs.push('autoplay')
  if (options.controls) attrs.push('controls')
  if (options.loop) attrs.push('loop')
  if (options.muted) attrs.push('muted')
  attrs.push('style="width:100%;height:100%;object-fit:contain"')

  kernel.windows.create({
    title,
    html: `<video src="${url}" ${attrs.join(' ')}></video>`,
    width: windowWidth,
    height: windowHeight,
    max: options.fullscreen
  })

  return { result: { duration, metadataFailed } }
}

/**
 * `audio`: a small player window, or with `quiet` no window at all (background playback).
 * Result: `{ duration, metadataFailed, quiet }`.
 */
export async function presentAudio(kernel: Kernel, _proc: unknown, params: Record<string, unknown>): Promise<Presented> {
  const path = str(params['path'], 'path')
  const title = str(params['title'], 'title')
  const label = str(params['label'], 'label')
  const options = (params['options'] ?? {}) as { autoplay?: boolean, loop?: boolean, muted?: boolean, volume?: number, quiet?: boolean }
  const volume = typeof options.volume === 'number' ? options.volume : 100

  const url = await blobUrl(kernel, path, mimeType(AUDIO_MIME, 'audio/mpeg', path))
  const audioElement = document.createElement('audio')
  audioElement.src = url
  audioElement.preload = 'metadata'

  let duration = 0
  let metadataFailed = false

  try {
    await loadMetadata(audioElement, 'audio')
    duration = audioElement.duration
  } catch {
    metadataFailed = true
  }

  audioElement.volume = volume / 100
  if (options.autoplay) audioElement.autoplay = true
  if (options.loop) audioElement.loop = true
  if (options.muted) audioElement.muted = true

  if (options.quiet) {
    // Autoplay may be blocked by the browser, which is fine for background playback
    audioElement.play().catch(error => console.warn('Autoplay blocked:', error))
    return { result: { duration, metadataFailed, quiet: true } }
  }

  const audioId = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  const name = escapeHtml(str(params['name'], 'name'))
  kernel.windows.create({
    title,
    html: `
      <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1e1e1e;color:#fff;font-family:monospace;padding:20px;box-sizing:border-box;">
        <div style="font-size:18px;margin-bottom:20px;text-align:center;word-break:break-word;">${name}</div>
        <audio id="${audioId}" src="${url}" ${options.autoplay ? 'autoplay' : ''} ${options.loop ? 'loop' : ''} ${options.muted ? 'muted' : ''} controls style="width:100%;max-width:600px;"></audio>
      </div>
      <script>
        (function() {
          const audio = document.getElementById('${audioId}');
          if (audio) {
            audio.volume = ${volume / 100};
            audio.addEventListener('play', () => console.log('Playing: ' + ${JSON.stringify(label)}));
            audio.addEventListener('ended', () => console.log('Finished: ' + ${JSON.stringify(label)}));
          }
        })();
      </script>
    `,
    width: 500,
    height: 200,
    max: false
  })

  return { result: { duration, metadataFailed, quiet: false } }
}
