import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Presented } from './index.ts'

const dirname = (filePath: string): string => {
  const index = filePath.lastIndexOf('/')
  return index <= 0 ? '/' : filePath.slice(0, index)
}

interface EditorOutcome {
  exitCode: number
  messages: Array<{ stream: 'err', text: string }>
}

/**
 * `vim`: vim.wasm in a 900x700 window. Ported from the original in-process command; what changed is
 * the shape around it. The program reads the files and works out the directory tree vim.wasm's
 * virtual filesystem needs (`params`: `{ files, dirs, cmdArgs, title }`), and this runs the editor
 * and reports back `{ exitCode, messages }` when it ends. `closed` holds the program until then, so
 * the process lives as long as the editor -- and closing the window ends it too (the original just
 * hung forever). Saved files (`:w` -> vim's export) are written through the *calling user's* shell
 * filesystem context, as before, so permissions apply.
 */
export async function presentEditor(kernel: Kernel, _proc: unknown, params: Record<string, unknown>, shell?: Shell): Promise<Presented> {
  const files = (params['files'] ?? {}) as Record<string, string>
  const dirsArray = (params['dirs'] ?? []) as string[]
  const cmdArgs = (params['cmdArgs'] ?? []) as string[]
  const windowTitle = String(params['title'] || 'vim')

  const { VimWasm, checkBrowserCompatibility } = await import('vim-wasm/vimwasm.js')

  const compatibilityError = checkBrowserCompatibility()
  if (compatibilityError !== undefined) throw new Error(compatibilityError)

  const container = document.createElement('div')
  container.style.width = '100%'
  container.style.height = '100%'
  container.style.display = 'flex'
  container.style.flexDirection = 'column'
  container.style.background = '#1e1e1e'
  container.style.overflow = 'hidden'

  const canvas = document.createElement('canvas')
  canvas.id = 'vim-canvas'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.flex = '1'

  const input = document.createElement('input')
  input.id = 'vim-input'
  input.type = 'text'
  input.autocomplete = 'off'
  input.autofocus = true
  input.style.position = 'absolute'
  input.style.left = '-9999px'
  input.style.width = '1px'
  input.style.height = '1px'
  input.style.opacity = '0'

  container.appendChild(canvas)
  container.appendChild(input)

  const finished = Promise.withResolvers<EditorOutcome>()
  const messages: EditorOutcome['messages'] = []
  let exitCode = 0
  let vimExited = false
  let resizeObserver: ResizeObserver | null = null
  let windowOpen = true

  const stopObserving = () => {
    resizeObserver?.disconnect()
    resizeObserver = null
  }
  const finish = () => {
    vimExited = true
    stopObserving()
    finished.resolve({ exitCode, messages })
  }

  const win = kernel.windows.create({
    title: windowTitle,
    width: 900,
    height: 700,
    max: false,
    // The user closing the window ends the session (returning falsy lets WinBox close it)
    onclose: () => {
      windowOpen = false
      if (!vimExited) {
        exitCode = 1
        finish()
      }
      return false
    }
  })

  win.mount(container)

  const closeWindow = () => { if (windowOpen) win.close() }

  let workerScriptPath: string
  try {
    workerScriptPath = new URL('vim-wasm/vim.js', import.meta.url).href
  } catch {
    closeWindow()
    throw new Error('failed to resolve worker script path. Please ensure vim-wasm is properly installed.')
  }

  const vim = new VimWasm({ canvas, input, workerScriptPath })

  vim.onFileExport = async (fullpath: string, contents: ArrayBuffer) => {
    try {
      const text = new TextDecoder().decode(contents)
      await shell?.context.fs.promises.writeFile(fullpath, text, 'utf-8')
    } catch (error) {
      messages.push({ stream: 'err', text: `vim: error writing file ${fullpath}: ${error instanceof Error ? error.message : 'Unknown error'}` })
    }
  }

  vim.onVimExit = (status: number) => {
    exitCode = status === 0 ? 0 : 1
    finish()
    closeWindow()
  }

  vim.onError = async (err: Error) => {
    console.error('[vim] Error callback triggered:', err)
    console.error('[vim] Error message:', err.message)
    console.error('[vim] Error stack:', err.stack)
    messages.push({ stream: 'err', text: `vim: error: ${err.message}` })
    if (!vimExited) {
      exitCode = 1
      finish()
      closeWindow()
    }
  }

  vim.onTitleUpdate = (title: string) => {
    win.setTitle(title || windowTitle)
  }

  vim.onVimInit = async () => {
    try {
      await vim.cmdline('autocmd BufWritePost * :export')
    } catch (error) {
      console.error('[vim] Failed to set up auto-export:', error)
    }

    const handleResize = () => {
      if (vimExited || !vim.isRunning()) return

      const rect = container.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.floor(rect.height)

      if (width > 0 && height > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width = width * dpr
        canvas.height = height * dpr

        vim.resize(width, height)
      }
    }

    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)
  }

  // Diagnostics for a malformed virtual directory tree: vim.wasm fails with an opaque ENOTDIR otherwise
  for (const filePath of Object.keys(files)) {
    const parentDir = dirname(filePath)
    if (!dirsArray.includes(parentDir)) {
      console.warn(`[vim] WARNING: Parent directory ${parentDir} of file ${filePath} is not in dirs array!`)
    }
    if (dirsArray.includes(filePath)) {
      console.error(`[vim] ERROR: File path ${filePath} is also in dirs array! This will cause ENOTDIR error.`)
    }
  }

  for (const dirPath of dirsArray) {
    if (files[dirPath] !== undefined) {
      console.error(`[vim] ERROR: Directory path ${dirPath} is also in files object! This will cause ENOTDIR error.`)
    }
  }

  for (let i = 0; i < dirsArray.length; i++) {
    const dir = dirsArray[i]
    if (dir) {
      const parent = dirname(dir)
      if (parent !== dir && !dirsArray.slice(0, i).includes(parent)) {
        console.warn(`[vim] WARNING: Directory ${dir} has parent ${parent} that comes after it in the array!`)
      }
    }
  }

  try {
    vim.start({ files, dirs: dirsArray, cmdArgs, debug: false })
  } catch (startError) {
    console.error('[vim] Error calling vim.start():', startError)
    if (startError instanceof Error && startError.stack) console.error('[vim] Start error stack:', startError.stack)
    closeWindow()
    throw new Error(`failed to start: ${startError instanceof Error ? startError.message : 'Unknown error'}`)
  }

  return {
    closed: finished.promise,
    dispose: () => {
      if (!vimExited) {
        exitCode = 1
        finish()
      }
      closeWindow()
    }
  }
}
