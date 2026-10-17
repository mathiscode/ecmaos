import type { ProcessEntryParams } from '@ecmaos/types'
import path from 'node:path'

import { monaco } from './monaco-env.ts'
import { createMenuBar } from './menu.ts'

import styles from './styles.module.css'

const main = async (params: ProcessEntryParams) => {
  const { args, kernel, shell, terminal, instance } = params

  const file = args?.[0] ? path.resolve(shell.cwd, args[0]) : path.resolve(shell.cwd, 'Untitled.txt')
  if (!file) { terminal.writeln('Usage: code <file>'); return 1 }

  try { await shell.context.fs.promises.mkdir(path.dirname(file), { recursive: true }) } catch { /* the directory exists */ }
  try { await shell.context.fs.promises.access(file) } catch { await shell.context.fs.promises.writeFile(file, '') }

  const fileHandle = await instance.open(file, 'r+')
  const value = await fileHandle.readFile('utf-8') as string
  let language = 'plaintext'

  const onclose = () => {
    fileHandle.close()
      .then(() => {
        instance.exit(0)
      })
      .catch((error) => {
        kernel.log.error(error)
      })
    return false
  }

  instance.keepAlive()

  const extension = file.split('.').pop() || ''
  const languages = monaco.languages.getLanguages()
  
  for (const lang of languages) {
    if (lang.extensions?.includes(`.${extension}`)) { language = lang.id; break }
  }

  const container = document.createElement('div')
  container.style.width = '100%'
  container.style.height = '100%'
  container.style.display = 'flex'
  container.style.flexDirection = 'column'

  const editorContainer = document.createElement('div')
  editorContainer.style.flex = '1'

  const icon = await import('./icon.png?inline')

  const win = await kernel.windows.create({
    title: `Code Editor - ${file}`,
    width: Math.floor(window.innerWidth * 0.75),
    height: Math.floor(window.innerHeight * 0.75),
    icon: icon.default,
    class: styles.window,
    onclose
  })

  // If the process is killed from outside (`^C`, `kill`) rather than the window being closed by
  // the user, nothing else can reach into this main-thread window to close it - register it here.
  instance.onDispose?.(() => win.close())

  const editor = monaco.editor.create(editorContainer, {
    value,
    language,
    theme: 'vs-dark',
    automaticLayout: true
  })

  const menuBar = createMenuBar(editor, {
    save: async () => {
      await fileHandle.truncate(0)
      await fileHandle.writeFile(editor.getValue())
      kernel.dom.toast.success('File saved')
    },
    exit: () => { win.close() }
  })
  container.appendChild(menuBar)
  container.appendChild(editorContainer)

  win.mount(container)
  globalThis.editor = editor
  terminal.blur()
  editor.focus()

  container.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault()
      await fileHandle.truncate(0)
      await fileHandle.writeFile(editor.getValue())
      kernel.dom.toast.success('File saved')
    }
  })

  return 0
}

export { display } from './display.ts'
export default main
