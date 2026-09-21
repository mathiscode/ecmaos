import { marked } from 'marked'
import '@alenaksu/json-viewer'

import type { Kernel } from '#kernel.ts'

import type { Presented } from './index.ts'

const extname = (filePath: string): string => {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}
const basename = (filePath: string): string => filePath.slice(filePath.lastIndexOf('/') + 1)

interface ViewOptions {
  autoplay: boolean
  loop: boolean
  muted: boolean
  volume: number
  controls: boolean
  fullscreen: boolean
  quiet: boolean
  width?: number
  height?: number
}

type FileType = 'pdf' | 'image' | 'audio' | 'video' | 'markdown' | 'json' | 'application/octet-stream'

function detectFileType(filePath: string): FileType {
  const ext = extname(filePath)
  
  // PDF
  if (ext === '.pdf') return 'pdf'
  
  // Markdown
  const markdownExts = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.txt']
  if (markdownExts.includes(ext)) return 'markdown'
  
  // JSON
  const jsonExts = ['.json', '.jsonl', '.jsonc', '.jsonld']
  if (jsonExts.includes(ext)) return 'json'
  
  // Images
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif']
  if (imageExts.includes(ext)) return 'image'
  
  // Audio
  const audioExts = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac', '.webm', '.wma', '.aiff', '.aif', '.3gp', '.amr']
  if (audioExts.includes(ext)) return 'audio'
  
  // Video
  const videoExts = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.avi', '.mkv', '.m4v', '.flv', '.wmv', '.3gp']
  if (videoExts.includes(ext)) return 'video'
  
  return 'application/octet-stream'
}

function getMimeType(filePath: string, fileType: FileType): string {
  const ext = extname(filePath)
  
  if (fileType === 'pdf') return 'application/pdf'
  
  if (fileType === 'image') {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff'
    }
    return mimeTypes[ext] || 'image/png'
  }
  
  if (fileType === 'audio') {
    const mimeTypes: Record<string, string> = {
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
    return mimeTypes[ext] || 'audio/mpeg'
  }
  
  if (fileType === 'video') {
    const mimeTypes: Record<string, string> = {
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
    return mimeTypes[ext] || 'video/mp4'
  }

  if (fileType === 'json') return 'application/json'

  return 'application/octet-stream'
}


async function loadAudioMetadata(audioElement: HTMLAudioElement): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout loading audio metadata'))
    }, 10000)

    audioElement.onloadedmetadata = () => {
      clearTimeout(timeout)
      resolve({
        duration: audioElement.duration
      })
    }

    audioElement.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Failed to load audio metadata'))
    }
  })
}

async function loadVideoMetadata(videoElement: HTMLVideoElement): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout loading video metadata'))
    }, 10000)

    videoElement.onloadedmetadata = () => {
      clearTimeout(timeout)
      resolve({
        width: videoElement.videoWidth,
        height: videoElement.videoHeight,
        duration: videoElement.duration
      })
    }

    videoElement.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Failed to load video metadata'))
    }
  })
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '?:??'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

function generateRandomClass(prefix: string): string {
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  return `${prefix}-${randomSuffix}`
}


/**
 * `view`'s display half, moved here unchanged from the original in-process command: shows one file
 * in its own window by type (PDF, markdown, JSON, image, audio, video) and returns the status lines
 * the command used to print itself (`Viewing: ...`, `Playing: ...`, warnings) as `messages`, for the
 * program to print in order. `params`: `{ path, file, windowTitle, options }`.
 */
export async function presentDocument(kernel: Kernel, _proc: unknown, params: Record<string, unknown>): Promise<Presented> {
  const fullPath = String(params['path'] ?? '')
  const file = String(params['file'] ?? '')
  const windowTitle = String(params['windowTitle'] ?? '')
  const options = params['options'] as ViewOptions
  if (!fullPath || !file || !options) throw new Error('missing path, file or options')

  const messages: Array<{ stream: 'out' | 'err', text: string }> = []
  const say = (text: string) => { messages.push({ stream: 'out', text }) }
  const warn = (text: string) => { messages.push({ stream: 'err', text }) }
  const fail = (text: string) => { messages.push({ stream: 'err', text }) }

  const fileData = await kernel.filesystem.fs.readFile(fullPath)
  const fileType = detectFileType(fullPath)
  const mimeType = getMimeType(fullPath, fileType)

  if (fileType === 'markdown') {
    // Read and parse markdown file
    const markdownText = new TextDecoder().decode(fileData)
    const htmlContent = await marked.parse(markdownText)
    
    const containerClass = generateRandomClass('markdown-container')
    
    const container = document.createElement('div')
    container.className = containerClass
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.display = 'flex'
    container.style.flexDirection = 'column'
    container.style.background = '#1e1e1e'
    container.style.overflow = 'auto'
    container.style.padding = '40px'
    container.style.boxSizing = 'border-box'
    container.style.fontFamily = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
    container.style.color = '#e0e0e0'
    container.style.lineHeight = '1.6'
    
    const contentWrapper = document.createElement('div')
    contentWrapper.style.maxWidth = '800px'
    contentWrapper.style.margin = '0 auto'
    contentWrapper.style.width = '100%'
    contentWrapper.innerHTML = htmlContent
    
    const style = document.createElement('style')
    style.textContent = `
      .${containerClass} h1, .${containerClass} h2, .${containerClass} h3, .${containerClass} h4, .${containerClass} h5, .${containerClass} h6 { color: #fff; margin-top: 1.5em; margin-bottom: 0.5em; }
      .${containerClass} h1 { font-size: 2em; border-bottom: 1px solid #444; padding-bottom: 0.3em; }
      .${containerClass} h2 { font-size: 1.5em; border-bottom: 1px solid #444; padding-bottom: 0.3em; }
      .${containerClass} h3 { font-size: 1.25em; }
      .${containerClass} code { background-color: #2d2d2d; padding: 2px 6px; border-radius: 3px; font-family: 'Courier New', monospace; color: #f8f8f2; }
      .${containerClass} pre { background-color: #2d2d2d; padding: 16px; border-radius: 6px; overflow-x: auto; }
      .${containerClass} pre code { background-color: transparent; padding: 0; }
      .${containerClass} a { color: #4a9eff; text-decoration: none; }
      .${containerClass} a:hover { text-decoration: underline; }
      .${containerClass} blockquote { border-left: 4px solid #4a9eff; padding-left: 16px; margin-left: 0; color: #b0b0b0; }
      .${containerClass} table { border-collapse: collapse; width: 100%; margin: 1em 0; }
      .${containerClass} th, .${containerClass} td { border: 1px solid #444; padding: 8px 12px; text-align: left; }
      .${containerClass} th { background-color: #2d2d2d; font-weight: bold; }
      .${containerClass} tr:nth-child(even) { background-color: #252525; }
      .${containerClass} img { max-width: 100%; height: auto; }
      .${containerClass} ul, .${containerClass} ol { padding-left: 2em; }
      .${containerClass} hr { border: none; border-top: 1px solid #444; margin: 2em 0; }
    `
    
    container.appendChild(style)
    container.appendChild(contentWrapper)
    
    const win = kernel.windows.create({
      title: windowTitle,
      width: 900,
      height: 700,
      max: false
    })
    
    win.mount(container)
  } else if (fileType === 'json') {
    // Read and parse JSON file
    const jsonText = new TextDecoder().decode(fileData)
    let jsonData: unknown

    try {
      jsonData = JSON.parse(jsonText)
    } catch (error) {
      fail(`view: invalid JSON in ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return { result: { messages } }
    }

    type JsonViewerElement = HTMLElement & {
      data?: unknown
      filter(regexOrPath: RegExp | string): void
      resetFilter(): void
      expand(regexOrPath: RegExp | string): void
      expandAll(): void
      collapse(regexOrPath: RegExp | string): void
      collapseAll(): void
    }

    const containerClass = generateRandomClass('json-container')
    
    const container = document.createElement('div')
    container.className = containerClass
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.display = 'flex'
    container.style.flexDirection = 'column'
    container.style.background = '#2a2f3a'
    container.style.overflow = 'hidden'
    
    const buttonBar = document.createElement('div')
    buttonBar.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px;
      background: #2a2f3a;
      border-bottom: 1px solid #3c3c3c;
      align-items: center;
    `
    
    const createInput = (placeholder: string): HTMLInputElement => {
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = placeholder
      input.style.cssText = `
        background: #263040;
        border: 1px solid #3c3c3c;
        border-radius: 3px;
        color: #fff;
        padding: 0 8px;
        font-size: 11px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        width: 120px;
        height: 22px;
        box-sizing: border-box;
        line-height: 22px;
        margin: 0;
        vertical-align: middle;
      `
      return input
    }
    
    const createButton = (text: string): HTMLButtonElement => {
      const button = document.createElement('button')
      button.textContent = text
      button.style.cssText = `
        background: #263040;
        border: 1px solid #263040;
        border-radius: 3px;
        color: #fff;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        padding: 0;
        height: 22px;
        box-sizing: border-box;
        line-height: 22px;
        white-space: nowrap;
        display: flex;
        align-items: center;
        justify-content: center;
        padding-left: 8px;
        padding-right: 8px;
        margin: 0;
        vertical-align: middle;
      `
      button.onmouseenter = () => {
        button.style.background = '#333'
        button.style.borderColor = '#333'
      }
      button.onmouseleave = () => {
        button.style.background = '#263040'
        button.style.borderColor = '#263040'
      }
      button.onmousedown = () => {
        button.style.background = '#263040'
      }
      button.onmouseup = () => {
        button.style.background = '#333'
      }
      return button
    }
    
    const createSection = (label: string): HTMLDivElement => {
      const section = document.createElement('div')
      section.style.cssText = `
        display: flex;
        align-items: center;
        gap: 4px;
        height: 22px;
      `
      const labelEl = document.createElement('span')
      labelEl.textContent = label
      labelEl.style.cssText = `
        color: #f8f8f2;
        font-size: 11px;
        font-weight: 600;
        width: 50px;
        flex-shrink: 0;
        line-height: 22px;
        display: flex;
        align-items: center;
        height: 22px;
      `
      section.appendChild(labelEl)
      return section
    }
    
    const filterSection = createSection('Filter:')
    const filterInput = createInput('Regex or path')
    filterSection.appendChild(filterInput)
    
    const expandSection = createSection('Expand:')
    const expandInput = createInput('Regex or path')
    const expandButton = createButton('Expand')
    const expandAllButton = createButton('Expand All')
    expandSection.appendChild(expandInput)
    expandSection.appendChild(expandButton)
    expandSection.appendChild(expandAllButton)
    
    const collapseSection = createSection('Collapse:')
    const collapseInput = createInput('Regex or path')
    const collapseButton = createButton('Collapse')
    const collapseAllButton = createButton('Collapse All')
    collapseSection.appendChild(collapseInput)
    collapseSection.appendChild(collapseButton)
    collapseSection.appendChild(collapseAllButton)
    
    buttonBar.appendChild(filterSection)
    buttonBar.appendChild(expandSection)
    buttonBar.appendChild(collapseSection)
    
    const jsonViewer = document.createElement('json-viewer') as JsonViewerElement
    jsonViewer.style.width = '100%'
    jsonViewer.style.flex = '1'
    jsonViewer.style.padding = '0.5rem'
    jsonViewer.style.overflow = 'auto'
    jsonViewer.data = jsonData
    
    jsonViewer.style.setProperty('--background-color', '#2a2f3a')
    jsonViewer.style.setProperty('--color', '#f8f8f2')
    jsonViewer.style.setProperty('--font-family', "'Courier New', monospace")
    jsonViewer.style.setProperty('--string-color', '#a3eea0')
    jsonViewer.style.setProperty('--number-color', '#d19a66')
    jsonViewer.style.setProperty('--boolean-color', '#4ba7ef')
    jsonViewer.style.setProperty('--null-color', '#df9cf3')
    jsonViewer.style.setProperty('--property-color', '#6fb3d2')
    jsonViewer.style.setProperty('--preview-color', '#deae8f')
    jsonViewer.style.setProperty('--highlight-color', '#c92a2a')
    
    filterInput.addEventListener('input', () => {
      const value = filterInput.value.trim()
      if (value) {
        try {
          const regex = new RegExp(value)
          jsonViewer.filter(regex)
        } catch {
          jsonViewer.filter(value)
        }
      } else {
        jsonViewer.resetFilter()
      }
    })
    
    expandButton.onclick = () => {
      const value = expandInput.value.trim()
      if (value) {
        try {
          const regex = new RegExp(value)
          jsonViewer.expand(regex)
        } catch {
          jsonViewer.expand(value)
        }
      }
    }
    
    expandAllButton.onclick = () => {
      jsonViewer.expandAll()
    }
    
    collapseButton.onclick = () => {
      const value = collapseInput.value.trim()
      if (value) {
        try {
          const regex = new RegExp(value)
          jsonViewer.collapse(regex)
        } catch {
          jsonViewer.collapse(value)
        }
      }
    }
    
    collapseAllButton.onclick = () => {
      jsonViewer.collapseAll()
    }
    
    const handleEnterKey = (input: HTMLInputElement, button: HTMLButtonElement) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          button.click()
        }
      })
    }
    
    handleEnterKey(expandInput, expandButton)
    handleEnterKey(collapseInput, collapseButton)
    
    container.appendChild(buttonBar)
    container.appendChild(jsonViewer)
    
    // Create window
    const win = kernel.windows.create({
      title: windowTitle,
      width: 900,
      height: 700,
      max: false
    })
    
    win.mount(container)
    say(`Viewing: ${file}`)
  } else if (fileType === 'pdf') {
    // Convert PDF to base64 and display in object tag
    // Use chunked encoding to avoid argument limit issues with large files
    const uint8Array = new Uint8Array(fileData)
    let binaryString = ''
    const chunkSize = 8192
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize)
      binaryString += String.fromCharCode(...chunk)
    }
    const base64Data = btoa(binaryString)
    const dataUrl = `data:application/pdf;base64,${base64Data}`
    
    const containerClass = generateRandomClass('pdf-container')
    
    const container = document.createElement('div')
    container.className = containerClass
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.display = 'flex'
    container.style.flexDirection = 'column'
    container.style.background = '#1e1e1e'
    container.style.overflow = 'hidden'
    
    const object = document.createElement('object')
    object.data = dataUrl
    object.type = 'application/pdf'
    object.style.width = '100%'
    object.style.height = '100%'
    object.style.flex = '1'
    
    const fallback = document.createElement('p')
    fallback.style.color = '#fff'
    fallback.style.padding = '20px'
    fallback.style.textAlign = 'center'
    fallback.textContent = 'Your browser does not support PDFs. '
    
    const downloadLink = document.createElement('a')
    downloadLink.href = dataUrl
    downloadLink.download = basename(file)
    downloadLink.style.color = '#4a9eff'
    downloadLink.textContent = 'Download PDF'
    
    fallback.appendChild(downloadLink)
    object.appendChild(fallback)
    container.appendChild(object)

    const win = kernel.windows.create({
      title: windowTitle,
      width: 800,
      height: 600,
      max: false
    })
    
    win.mount(container)

    say(`Viewing: ${file}`)
  } else if (fileType === 'image') {
    // Display image directly
    const blob = new Blob([new Uint8Array(fileData)], { type: mimeType })
    const url = URL.createObjectURL(blob)

    const containerClass = generateRandomClass('image-container')
    
    const container = document.createElement('div')
    container.className = containerClass
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.display = 'flex'
    container.style.alignItems = 'center'
    container.style.justifyContent = 'center'
    container.style.background = '#1e1e1e'
    container.style.overflow = 'auto'
    container.style.padding = '20px'
    container.style.boxSizing = 'border-box'
    
    const img = document.createElement('img')
    img.src = url
    img.alt = basename(file)
    img.style.maxWidth = '100%'
    img.style.maxHeight = '100%'
    img.style.objectFit = 'contain'
    
    container.appendChild(img)

    const win = kernel.windows.create({
      title: windowTitle,
      width: 800,
      height: 600,
      max: false
    })
    
    win.mount(container)

    say(`Viewing: ${file}`)
  } else if (fileType === 'audio') {
    // Handle audio similar to play command
    const blob = new Blob([new Uint8Array(fileData)], { type: mimeType })
    const url = URL.createObjectURL(blob)

    // Load audio metadata
    const audioElement = document.createElement('audio')
    audioElement.src = url
    audioElement.preload = 'metadata'

    let duration = 0

    try {
      const metadata = await loadAudioMetadata(audioElement)
      duration = metadata.duration
    } catch (error) {
      warn(`view: warning: could not load metadata for ${file}`)
    }

    // Set audio properties
    audioElement.volume = options.volume / 100
    if (options.autoplay) audioElement.autoplay = true
    if (options.loop) audioElement.loop = true
    if (options.muted) audioElement.muted = true

    if (options.quiet) {
      // Background playback - no window
      audioElement.play().catch((error) => {
        // Autoplay may be blocked by browser, but that's okay for quiet mode
        console.warn('Autoplay blocked:', error)
      })
      
      if (duration > 0) {
        const durationStr = formatDuration(duration)
        say(`Playing in background: ${file} (${durationStr})`)
      } else {
        say(`Playing in background: ${file}`)
      }
    } else {
      // Create a simple audio player window
      const audioId = `audio-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const containerClass = generateRandomClass('audio-container')
      
      const container = document.createElement('div')
      container.className = containerClass
      container.style.width = '100%'
      container.style.height = '100%'
      container.style.display = 'flex'
      container.style.flexDirection = 'column'
      container.style.alignItems = 'center'
      container.style.justifyContent = 'center'
      container.style.background = '#1e1e1e'
      container.style.color = '#fff'
      container.style.fontFamily = 'monospace'
      container.style.padding = '20px'
      container.style.boxSizing = 'border-box'
      
      const title = document.createElement('div')
      title.textContent = basename(file)
      title.style.fontSize = '18px'
      title.style.marginBottom = '20px'
      title.style.textAlign = 'center'
      title.style.wordBreak = 'break-word'
      
      const audio = document.createElement('audio')
      audio.id = audioId
      audio.src = url
      audio.controls = true
      audio.style.width = '100%'
      audio.style.maxWidth = '600px'
      
      if (options.autoplay) audio.autoplay = true
      if (options.loop) audio.loop = true
      if (options.muted) audio.muted = true
      
      audio.volume = options.volume / 100
      audio.addEventListener('play', () => console.log(`Playing: ${file}`))
      audio.addEventListener('ended', () => console.log(`Finished: ${file}`))
      
      container.appendChild(title)
      container.appendChild(audio)

      const win = kernel.windows.create({
        title: windowTitle,
        width: 500,
        height: 200,
        max: false
      })
      
      win.mount(container)

      if (duration > 0) {
        const durationStr = formatDuration(duration)
        say(`Playing: ${file} (${durationStr})`)
      } else {
        say(`Playing: ${file}`)
      }
    }
  } else if (fileType === 'video') {
    // Handle video similar to video command
    const blob = new Blob([new Uint8Array(fileData)], { type: mimeType })
    const url = URL.createObjectURL(blob)

    // Load video metadata
    const videoElement = document.createElement('video')
    videoElement.src = url
    videoElement.preload = 'metadata'

    let videoWidth: number
    let videoHeight: number
    let duration: number

    try {
      const metadata = await loadVideoMetadata(videoElement)
      videoWidth = metadata.width
      videoHeight = metadata.height
      duration = metadata.duration
    } catch (error) {
      warn(`view: warning: could not load metadata for ${file}, using default size`)
      videoWidth = 640
      videoHeight = 360
      duration = 0
    }

    // Calculate window dimensions
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
      // Auto-size: fit to screen if video is larger, otherwise use video dimensions
      const scale = Math.min(innerWidth / videoWidth, innerHeight / videoHeight, 1)
      windowWidth = Math.round(videoWidth * scale)
      windowHeight = Math.round(videoHeight * scale)
    }

    // Ensure minimum size
    windowWidth = Math.max(windowWidth, 320)
    windowHeight = Math.max(windowHeight, 180)

    const containerClass = generateRandomClass('video-container')
    
    const container = document.createElement('div')
    container.className = containerClass
    container.style.width = '100%'
    container.style.height = '100%'
    
    const video = document.createElement('video')
    video.src = url
    video.style.width = '100%'
    video.style.height = '100%'
    video.style.objectFit = 'contain'
    
    if (options.autoplay) video.autoplay = true
    if (options.controls) video.controls = true
    if (options.loop) video.loop = true
    if (options.muted) video.muted = true

    container.appendChild(video)

    const win = kernel.windows.create({
      title: windowTitle,
      width: windowWidth,
      height: windowHeight,
      max: options.fullscreen
    })
    
    win.mount(container)

    if (duration > 0) {
      const minutes = Math.floor(duration / 60)
      const seconds = Math.floor(duration % 60)
      say(`Playing: ${file} (${minutes}:${seconds.toString().padStart(2, '0')})`)
    } else {
      say(`Playing: ${file}`)
    }
  }
  return { result: { messages } }
}
