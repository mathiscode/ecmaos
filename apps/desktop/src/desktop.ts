import type { Kernel, WindowInfo } from '@ecmaos/types'

import { parseDesktopEntry } from './desktop-entry.js'
import type { DesktopEntry } from './desktop-entry.js'
import { DefaultSettings, imageFileName, parseSettings, Presets, serializeSettings, settingsPaths, wallpaperCss } from './settings.js'
import type { DesktopSettings, Wallpaper } from './settings.js'

const TaskbarHeight = 40

const TerminalEntry: DesktopEntry = {
  id: 'terminal', name: 'Terminal', comment: 'A shell in a window', exec: '', terminal: true, categories: ['System', 'TerminalEmulator']
}

const css = `
#ecmaos-desktop { position: fixed; inset: 0; z-index: 2; overflow: hidden; font-family: system-ui, sans-serif; color: #e8e8e8;
  background: radial-gradient(circle at 30% 20%, #2a3b55 0%, #141a26 60%, #0b0e14 100%); }
#ecmaos-desktop .taskbar { position: fixed; left: 0; right: 0; bottom: 0; height: ${TaskbarHeight}px; display: flex; align-items: center; gap: 6px;
  padding: 0 6px; background: rgba(16, 18, 24, 0.96); border-top: 1px solid #2c3140; z-index: 100000; box-sizing: border-box; }
#ecmaos-desktop button { width: auto; min-width: 0; margin: 0; flex: none; font: inherit; color: inherit; background: #232838; border: 1px solid #343b50; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
#ecmaos-desktop button:hover { background: #2d3449; }
#ecmaos-desktop .workspaces { display: flex; gap: 2px; }
#ecmaos-desktop .workspaces button { padding: 4px 8px; min-width: 26px; }
#ecmaos-desktop .workspaces button.current { background: #3a4668; border-color: #5b6aa0; }
#ecmaos-desktop .tasks { flex: 1; display: flex; gap: 4px; overflow: hidden; }
#ecmaos-desktop .tasks button { flex: 0 1 180px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ecmaos-desktop .tasks button.focused { background: #3a4668; border-color: #5b6aa0; }
#ecmaos-desktop .tasks button.minimized { opacity: 0.6; }
#ecmaos-desktop .clock { padding: 0 8px; font-variant-numeric: tabular-nums; }
#ecmaos-desktop .menu { position: fixed; left: 6px; bottom: ${TaskbarHeight + 4}px; min-width: 240px; max-height: 60vh; overflow: auto; z-index: 100001;
  background: rgba(20, 23, 32, 0.98); border: 1px solid #343b50; border-radius: 6px; padding: 4px; }
#ecmaos-desktop .menu button { display: block; width: 100%; flex: none; text-align: left; border: 0; background: transparent; padding: 6px 10px; }
#ecmaos-desktop .menu small { display: block; opacity: 0.6; }
#ecmaos-desktop .menu.context { left: auto; bottom: auto; min-width: 200px; }
#ecmaos-desktop .menu hr { border: 0; border-top: 1px solid #343b50; margin: 4px 0; }
`

export interface DesktopOptions {
  kernel: Kernel
  username: string
  /** Called once when the desktop has been taken down */
  onExit: () => void
}

/**
 * The desktop shell: a wallpaper, a taskbar with a launcher, one button per window and a clock. It takes over the page
 * like a virtual console; Ctrl+Alt+F1 to F8 (or Exit) takes it down and shows the terminal that is underneath.
 */
export class Desktop {
  private readonly _kernel: Kernel
  private readonly _username: string
  private readonly _onExit: () => void
  private readonly _root = document.createElement('div')
  private readonly _style = document.createElement('style')
  private readonly _tasks = document.createElement('div')
  private readonly _clock = document.createElement('span')
  private readonly _workspaceButtons = document.createElement('div')
  private _settings: DesktopSettings = { ...DefaultSettings }
  private _imageUrl?: string
  private _menu?: HTMLElement
  private _entries: DesktopEntry[] = []
  private _disposers: Array<() => void> = []
  private _running = false

  constructor(options: DesktopOptions) {
    this._kernel = options.kernel
    this._username = options.username
    this._onExit = options.onExit
  }

  async start() {
    if (this._running) return
    this._running = true
    this._style.textContent = css
    document.head.appendChild(this._style)
    this._root.id = 'ecmaos-desktop'

    const taskbar = document.createElement('div')
    taskbar.className = 'taskbar'
    const start = document.createElement('button')
    start.textContent = '👽'
    start.title = 'Applications'
    start.setAttribute('aria-label', 'Applications')
    start.onclick = event => { event.stopPropagation(); void this._toggleMenu() }
    this._workspaceButtons.className = 'workspaces'
    this._tasks.className = 'tasks'
    this._clock.className = 'clock'
    const exit = document.createElement('button')
    exit.textContent = 'Exit'
    exit.title = 'Return to the terminal (Ctrl+Alt+F1)'
    exit.onclick = () => this.stop()
    taskbar.append(start, this._workspaceButtons, this._tasks, this._clock, exit)
    this._root.append(taskbar)
    document.body.appendChild(this._root)

    this._kernel.windows.setWorkarea({ bottom: TaskbarHeight })
    this._kernel.windows.setMinimizeMode('hidden')

    await this._loadSettings()
    // With no desktop there is one workspace, so no window is ever left hidden on one nobody can reach
    this._kernel.windows.setWorkspaceCount(this._settings.workspaces)
    this._disposers.push(() => this._kernel.windows.setWorkspaceCount(1))
    await this._applyWallpaper()

    const refresh = () => this._renderTasks()
    for (const event of ['create', 'update', 'focus', 'close'] as const) this._disposers.push(this._kernel.windows.on(event, refresh))
    this._disposers.push(this._kernel.windows.onWorkspace(() => { this._renderWorkspaces(); this._renderTasks() }))
    this._root.addEventListener('contextmenu', event => {
      if (event.target !== this._root) return
      event.preventDefault()
      event.stopPropagation()
      this._wallpaperMenu(event.clientX, event.clientY)
    })
    this._disposers.push(() => this._kernel.windows.setWorkarea({ bottom: 0 }))
    this._disposers.push(() => this._kernel.windows.setMinimizeMode('dock'))

    const closeMenu = () => this._closeMenu()
    this._root.addEventListener('click', closeMenu)
    const keys = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey) return
      const digit = /^Digit([1-9])$/.exec(event.code)
      if (digit) {
        // Ctrl+Alt+1 to 9 shows a workspace; with Shift the focused window goes there too
        const workspace = Number(digit[1]) - 1
        if (workspace >= this._kernel.windows.workspaces) return
        event.preventDefault()
        const focused = event.shiftKey ? this._kernel.windows.list().find(info => info.focused && !info.hidden) : undefined
        if (focused) this._kernel.windows.moveToWorkspace(focused.id, workspace)
        this._kernel.windows.switchWorkspace(workspace)
        if (focused) this._kernel.windows.focus(focused.id)
        return
      }
      const match = /^F([1-8])$/.exec(event.key)
      if (!match) return
      event.preventDefault()
      const tty = Number(match[1]) - 1
      this.stop()
      void this._kernel.switchTty(tty).catch(() => {})
    }
    window.addEventListener('keydown', keys, true)
    this._disposers.push(() => window.removeEventListener('keydown', keys, true))

    this._renderWorkspaces()
    this._tickClock()
    const clock = setInterval(() => this._tickClock(), 15000)
    this._disposers.push(() => clearInterval(clock))
    this._renderTasks()
  }

  /** Takes the desktop down. Windows that are open stay open, over the terminal */
  stop() {
    if (!this._running) return
    this._running = false
    this._closeMenu()
    for (const dispose of this._disposers.splice(0)) dispose()
    this._root.remove()
    this._style.remove()
    if (this._imageUrl) URL.revokeObjectURL(this._imageUrl)
    this._imageUrl = undefined
    this._onExit()
  }

  /** The applications in the menu: Terminal, then every entry under the XDG application directories */
  async entries(): Promise<DesktopEntry[]> {
    const { fs } = this._kernel.filesystem
    const directories = ['/usr/share/applications', '/usr/local/share/applications', `${this._home()}/.local/share/applications`]
    const found = new Map<string, DesktopEntry>()
    for (const directory of directories) {
      let names: string[]
      try { names = await fs.readdir(directory) } catch { continue }
      for (const name of names) {
        if (!name.endsWith('.desktop')) continue
        try {
          const entry = parseDesktopEntry(name.slice(0, -'.desktop'.length), await fs.readFile(`${directory}/${name}`, 'utf-8'))
          // A later directory (the user's) overrides an earlier one
          if (entry) found.set(entry.id, entry)
        } catch { /* unreadable entry */ }
      }
    }
    return [TerminalEntry, ...[...found.values()].sort((a, b) => a.name.localeCompare(b.name))]
  }

  /** Runs an entry: a terminal window for terminal programs, otherwise a program that opens its own windows */
  async launch(entry: DesktopEntry) {
    const options = { username: this._username }
    try {
      if (entry.id === TerminalEntry.id) {
        await this._kernel.openTerminalWindow({ ...options, title: `Terminal - ${this._username}` })
      } else if (entry.terminal) {
        await this._kernel.openTerminalWindow({ ...options, title: entry.name, command: '/bin/ecmash', args: ['-c', entry.exec] })
      } else {
        void this._kernel.runDetached({ ...options, command: entry.exec }).then(code => {
          if (code !== 0) this._kernel.dom.toast.error(`${entry.name} exited with status ${code}`)
        })
      }
    } catch (error) {
      this._kernel.dom.toast.error(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private _home() {
    const user = [...this._kernel.users.all.values()].find(candidate => candidate.username === this._username)
    return user?.home || '/root'
  }

  private async _toggleMenu() {
    if (this._menu) return this._closeMenu()
    const menu = document.createElement('div')
    menu.className = 'menu'
    menu.onclick = event => event.stopPropagation()
    this._menu = menu
    this._root.appendChild(menu)
    for (const entry of await this.entries()) {
      if (this._menu !== menu) return
      const item = document.createElement('button')
      item.textContent = entry.name
      if (entry.comment) {
        const small = document.createElement('small')
        small.textContent = entry.comment
        item.appendChild(small)
      }
      item.onclick = () => { this._closeMenu(); void this.launch(entry) }
      menu.appendChild(item)
    }
  }

  private _closeMenu() {
    this._menu?.remove()
    this._menu = undefined
  }

  /** The settings file, as the user's; a missing or bad one is the defaults */
  private async _loadSettings() {
    const { fs } = this._kernel.filesystem
    try { this._settings = parseSettings(await fs.readFile(settingsPaths(this._home()).file, 'utf-8')) } catch { this._settings = parseSettings(undefined) }
  }

  private async _saveSettings() {
    const { fs } = this._kernel.filesystem
    const { directory, file } = settingsPaths(this._home())
    try {
      await this._makeDirectories(directory)
      await fs.writeFile(file, serializeSettings(this._settings))
      await this._ownedByUser(file)
    } catch (error) {
      this._kernel.dom.toast.error(`Settings were not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Creates the directories of a path under the user's home, each one the user's */
  private async _makeDirectories(directory: string) {
    const { fs } = this._kernel.filesystem
    const home = this._home()
    let current = home
    for (const part of directory.slice(home.length).split('/').filter(Boolean)) {
      current = `${current}/${part}`
      try { await fs.stat(current) } catch {
        await fs.mkdir(current)
        await this._ownedByUser(current)
      }
    }
  }

  private async _ownedByUser(path: string) {
    const user = [...this._kernel.users.all.values()].find(candidate => candidate.username === this._username)
    if (user) await this._kernel.filesystem.fs.chown(path, user.uid, user.gid)
  }

  private async _applyWallpaper() {
    const wallpaper = this._settings.wallpaper
    if (this._imageUrl) { URL.revokeObjectURL(this._imageUrl); this._imageUrl = undefined }
    if (wallpaper.kind === 'image') {
      try {
        const { fs } = this._kernel.filesystem
        const bytes = await fs.readFile(`${settingsPaths(this._home()).directory}/${wallpaper.file}`)
        this._imageUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: imageType(wallpaper.file) }))
      } catch { /* the file is gone: the default shows */ }
    }
    this._root.style.background = wallpaperCss(wallpaper, this._imageUrl)
  }

  private async _setWallpaper(wallpaper: Wallpaper) {
    this._settings = { ...this._settings, wallpaper }
    await this._applyWallpaper()
    await this._saveSettings()
  }

  /** The menu for the wallpaper: presets, a color and a picture from a file */
  private _wallpaperMenu(x: number, y: number) {
    const items: Array<{ label: string, run?: () => void } | 'separator'> = [
      ...Presets.map(preset => ({ label: preset.name, run: () => void this._setWallpaper({ kind: 'preset', id: preset.id }) })),
      'separator',
      { label: 'Color...', run: () => this._chooseColor() },
      { label: 'Picture...', run: () => this._choosePicture() }
    ]
    this._contextMenu(x, y, items)
  }

  private _chooseColor() {
    const input = document.createElement('input')
    input.type = 'color'
    input.onchange = () => void this._setWallpaper({ kind: 'color', value: input.value })
    input.click()
  }

  private _choosePicture() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const chosen = input.files?.[0]
      if (!chosen) return
      const name = imageFileName(chosen.name)
      if (!name) return this._kernel.dom.toast.error('Pick a picture (png, jpg, gif, webp, avif, bmp or svg)')
      try {
        const { fs } = this._kernel.filesystem
        const { directory } = settingsPaths(this._home())
        await this._makeDirectories(directory)
        for (const old of await fs.readdir(directory)) if (/^wallpaper\./.test(old)) await fs.unlink(`${directory}/${old}`)
        await fs.writeFile(`${directory}/${name}`, new Uint8Array(await chosen.arrayBuffer()))
        await this._ownedByUser(`${directory}/${name}`)
        await this._setWallpaper({ kind: 'image', file: name })
      } catch (error) {
        this._kernel.dom.toast.error(`Wallpaper: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    input.click()
  }

  /** A menu at the pointer; it closes when anything else is clicked */
  private _contextMenu(x: number, y: number, items: Array<{ label: string, run?: () => void } | 'separator'>) {
    this._closeMenu()
    const menu = document.createElement('div')
    menu.className = 'menu context'
    menu.onclick = event => event.stopPropagation()
    menu.oncontextmenu = event => event.preventDefault()
    for (const item of items) {
      if (item === 'separator') { menu.appendChild(document.createElement('hr')); continue }
      const button = document.createElement('button')
      button.textContent = item.label
      button.onclick = () => { this._closeMenu(); item.run?.() }
      menu.appendChild(button)
    }
    this._menu = menu
    this._root.appendChild(menu)
    const box = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - box.width))}px`
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - TaskbarHeight - box.height))}px`
  }

  private _renderWorkspaces() {
    const { workspaces, workspace } = this._kernel.windows
    const buttons: HTMLButtonElement[] = []
    for (let i = 0; i < workspaces; i++) {
      const button = document.createElement('button')
      button.textContent = String(i + 1)
      button.title = `Workspace ${i + 1} (Ctrl+Alt+${i + 1})`
      if (i === workspace) button.classList.add('current')
      button.onclick = () => this._kernel.windows.switchWorkspace(i)
      buttons.push(button)
    }
    this._workspaceButtons.replaceChildren(...buttons)
  }

  private _renderTasks() {
    const windows = this._kernel.windows.list().filter(info => !info.modal && !info.hidden)
    this._tasks.replaceChildren(...windows.map(info => this._taskButton(info)))
  }

  private _taskButton(info: WindowInfo) {
    const button = document.createElement('button')
    button.textContent = info.title
    button.title = info.title
    if (info.focused) button.classList.add('focused')
    if (info.state === 'minimized') button.classList.add('minimized')
    button.onclick = () => {
      const current = this._kernel.windows.get(info.id)?.info
      if (current?.focused && current.state !== 'minimized') this._kernel.windows.update(info.id, { state: 'minimized' })
      else this._kernel.windows.focus(info.id)
    }
    button.oncontextmenu = event => {
      event.preventDefault()
      event.stopPropagation()
      const moves = Array.from({ length: this._kernel.windows.workspaces }, (_, i) => ({ label: `Move to workspace ${i + 1}`, run: () => this._kernel.windows.moveToWorkspace(info.id, i) }))
        .filter((_, i) => i !== info.workspace)
      this._contextMenu(event.clientX, event.clientY - 8, [...moves, 'separator', { label: 'Close', run: () => { this._kernel.windows.close(info.id) } }])
    }
    return button
  }

  private _tickClock() {
    this._clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
}

const imageType = (file: string) => ({ svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg' } as Record<string, string>)[file.split('.').pop()?.toLowerCase() ?? ''] ?? `image/${file.split('.').pop()?.toLowerCase() ?? 'png'}`
