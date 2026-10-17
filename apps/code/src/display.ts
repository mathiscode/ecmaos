import type { AppSdk } from '@ecmaos/types'
import path from 'node:path'

import { monaco } from './monaco-env.ts'
import { createMenuBar } from './menu.ts'

/**
 * The editor for a host with no page of its own (a Node process): it runs in the sandbox of its window and reads and
 * writes the file through the SDK. Unsaved changes make the display ask before the window is closed.
 */
export const display = async (sdk: AppSdk) => {
  const file = path.resolve(sdk.cwd, sdk.args[0] ?? 'Untitled.txt')
  try { await sdk.fs.mkdir(path.dirname(file), { recursive: true }) } catch { /* the directory exists */ }
  let saved: string
  try { saved = await sdk.fs.readFile(file, 'utf8') } catch { await sdk.fs.writeFile(file, ''); saved = '' }

  let language = 'plaintext'
  const extension = file.split('.').pop() || ''
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(`.${extension}`)) { language = lang.id; break }
  }

  document.documentElement.style.height = document.body.style.height = '100%'
  document.body.style.margin = '0'
  const container = document.createElement('div')
  container.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column'
  const editorContainer = document.createElement('div')
  editorContainer.style.flex = '1'
  editorContainer.style.minHeight = '0'

  const editor = monaco.editor.create(editorContainer, { value: saved, language, theme: 'vs-dark', automaticLayout: true })
  const title = (dirty: boolean) => sdk.window.setTitle(`Code Editor - ${file}${dirty ? ' *' : ''}`)

  const save = async () => {
    const value = editor.getValue()
    try {
      await sdk.fs.writeFile(file, value)
    } catch (error) {
      sdk.toast(`Could not save: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    saved = value
    sdk.window.setDirty(false)
    void title(false)
    sdk.toast('File saved', 'success')
  }

  let dirty = false
  editor.onDidChangeModelContent(() => {
    const now = editor.getValue() !== saved
    if (now === dirty) return
    dirty = now
    sdk.window.setDirty(now)
    void title(now)
  })

  container.append(createMenuBar(editor, {
    save,
    exit: () => { if (!dirty || confirm('Discard unsaved changes?')) void sdk.exit(0) }
  }), editorContainer)
  container.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 's') { event.preventDefault(); void save() }
  })
  document.body.append(container)
  sdk.onDispose(() => editor.dispose())
  await title(false)
  editor.focus()
}
