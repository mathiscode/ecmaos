import type { Process as ZenFSProcess } from '@zenfs/linux'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { DetachedOptions, TerminalWindowHandle, TerminalWindowOptions, WindowHandle } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'
import { createPty } from '#lib/pty.ts'
import type { KernelPty } from '#lib/pty.ts'

export interface TerminalWindow extends TerminalWindowHandle {
  window: WindowHandle
  pty: KernelPty
  process: ZenFSProcess
  terminal: XTerm
  exited: Promise<number>
}

/**
 * Opens a window with a terminal emulator on a pty the kernel holds the master of, and runs a program (a login shell by
 * default) on the slave. Typing and the window size go to the master; what the program writes is drawn. When the program
 * exits the window closes; when the window closes the master is released, which hangs the program up.
 * The terminal does not use the kernel's `Terminal` class, so it is not one of the eight ttys.
 */
export async function openTerminalWindow(kernel: Kernel, options: TerminalWindowOptions): Promise<TerminalWindow> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])

  // Owned by the kernel (so it outlives what opened it) but on the user's uid, which is what lets that user's `wmctrl` see it
  const user = [...kernel.users.all.values()].find(candidate => candidate.username === options.username)
  const window = kernel.windows.create({
    title: options.title ?? (options.login ? 'Login' : `Terminal - ${options.username}`),
    width: options.width ?? 720,
    height: options.height ?? 440,
    class: 'ecmaos-window ecmaos-terminal-window',
    owner: options.owner ?? (user ? { pid: 0, uid: user.uid, gid: user.gid } : undefined)
  })

  const container = document.createElement('div')
  container.style.cssText = 'width:100%;height:100%;background:#000;overflow:hidden;'
  window.mount(container)

  const terminal = new Terminal({ cursorBlink: true, fontFamily: 'monospace', fontSize: 14, allowProposedApi: true })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(container)
  try { fit.fit() } catch { /* not laid out yet; the observer below fits it */ }

  const pty = createPty({ cols: terminal.cols, rows: terminal.rows })
  const subscriptions = [
    { dispose: pty.onData(data => terminal.write(data)) },
    terminal.onData(data => pty.write(data)),
    terminal.onBinary(data => pty.write(Uint8Array.from(data, char => char.charCodeAt(0)))),
    terminal.onResize(({ cols, rows }) => pty.resize(cols, rows))
  ]

  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { try { fit.fit() } catch { /* hidden */ } })
  observer?.observe(container)

  let closed = false
  const teardown = () => {
    if (closed) return
    closed = true
    observer?.disconnect()
    for (const subscription of subscriptions) subscription.dispose()
    pty.close()
    terminal.dispose()
    unsubscribe()
  }
  const unsubscribe = kernel.windows.on('close', info => { if (info.id === window.id) teardown() })

  try {
    const process = await kernel.spawnOnPty({
      username: options.username,
      pty,
      command: options.login ? '/sbin/getty' : options.command ?? '/bin/ecmash',
      args: options.login ? ['-p'] : options.command ? options.args : ['-l', ...(options.args ?? [])],
      cwd: options.cwd,
      env: options.env
    })
    void process.exited.then(() => { window.close(true); teardown() })
    return { window, pty, process, terminal, exited: process.exited }
  } catch (error) {
    window.close(true)
    teardown()
    throw error
  }
}

/**
 * Runs a program as a user on a pty that nothing reads, for programs that open their own windows (a DOM app). The pty
 * lives as long as the program does. Resolves to the exit code.
 */
export async function runDetached(kernel: Kernel, options: DetachedOptions): Promise<number> {
  const pty = createPty()
  try {
    const process = await kernel.spawnOnPty({ username: options.username, pty, command: '/bin/ecmash', args: ['-c', [options.command, ...(options.args ?? [])].join(' ')], cwd: options.cwd, env: options.env })
    return await process.exited
  } finally {
    pty.close()
  }
}
