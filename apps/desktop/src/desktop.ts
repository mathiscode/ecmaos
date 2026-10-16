import type { Kernel, WindowInfo } from '@ecmaos/types'

import { parseDesktopEntry } from './desktop-entry.js'
import type { DesktopEntry } from './desktop-entry.js'

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
#ecmaos-desktop .tasks { flex: 1; display: flex; gap: 4px; overflow: hidden; }
#ecmaos-desktop .tasks button { flex: 0 1 180px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ecmaos-desktop .tasks button.focused { background: #3a4668; border-color: #5b6aa0; }
#ecmaos-desktop .tasks button.minimized { opacity: 0.6; }
#ecmaos-desktop .clock { padding: 0 8px; font-variant-numeric: tabular-nums; }
#ecmaos-desktop .menu { position: fixed; left: 6px; bottom: ${TaskbarHeight + 4}px; min-width: 240px; max-height: 60vh; overflow: auto; z-index: 100001;
  background: rgba(20, 23, 32, 0.98); border: 1px solid #343b50; border-radius: 6px; padding: 4px; }
#ecmaos-desktop .menu button { display: block; width: 100%; flex: none; text-align: left; border: 0; background: transparent; padding: 6px 10px; }
#ecmaos-desktop .menu small { display: block; opacity: 0.6; }
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
    start.textContent = 'ecmaOS'
    start.onclick = event => { event.stopPropagation(); void this._toggleMenu() }
    this._tasks.className = 'tasks'
    this._clock.className = 'clock'
    const exit = document.createElement('button')
    exit.textContent = 'Exit'
    exit.title = 'Return to the terminal (Ctrl+Alt+F1)'
    exit.onclick = () => this.stop()
    taskbar.append(start, this._tasks, this._clock, exit)
    this._root.append(taskbar)
    document.body.appendChild(this._root)

    this._kernel.windows.setWorkarea({ bottom: TaskbarHeight })

    const refresh = () => this._renderTasks()
    for (const event of ['create', 'update', 'focus', 'close'] as const) this._disposers.push(this._kernel.windows.on(event, refresh))
    this._disposers.push(() => this._kernel.windows.setWorkarea({ bottom: 0 }))

    const closeMenu = () => this._closeMenu()
    this._root.addEventListener('click', closeMenu)
    const keys = (event: KeyboardEvent) => {
      const match = /^F([1-8])$/.exec(event.key)
      if (!match || !event.ctrlKey || !event.altKey) return
      event.preventDefault()
      const tty = Number(match[1]) - 1
      this.stop()
      void this._kernel.switchTty(tty).catch(() => {})
    }
    window.addEventListener('keydown', keys, true)
    this._disposers.push(() => window.removeEventListener('keydown', keys, true))

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

  private _renderTasks() {
    const windows = this._kernel.windows.list().filter(info => !info.modal)
    this._tasks.replaceChildren(...windows.map(info => this._taskButton(info)))
  }

  private _taskButton(info: WindowInfo) {
    const button = document.createElement('button')
    button.textContent = info.title
    button.title = info.title
    if (info.focused) button.classList.add('focused')
    if (info.state === 'minimized') button.classList.add('minimized')
    button.onclick = () => {
      if (info.focused && info.state !== 'minimized') this._kernel.windows.update(info.id, { state: 'minimized' })
      else this._kernel.windows.focus(info.id)
    }
    return button
  }

  private _tickClock() {
    this._clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
}
