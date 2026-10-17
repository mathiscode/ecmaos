import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { WindowGeometry } from '@ecmaos/types'

/** A host window that was started */
export interface HostWindow {
  /** Asks the window to go away (kills the browser process behind it) */
  kill(): void
  /** Resolves when the window's process has ended */
  exited: Promise<void>
}

/** What a window is asked to be besides its place and title; a launcher may ignore it */
export interface LaunchOptions {
  /** No chrome from the host (title bar, borders) */
  frameless?: boolean
}

/** Opens a host window that loads `url`; `unavailable` explains why it cannot */
export interface Launcher {
  readonly unavailable?: string
  launch(url: string, geometry: WindowGeometry, title: string, options?: LaunchOptions): HostWindow
}

const Linux = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable']

const candidates = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  if (platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ]
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter((root): root is string => !!root)
    return roots.flatMap(root => [
      path.join(root, 'Google/Chrome/Application/chrome.exe'),
      path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe')
    ])
  }
  return (env['PATH'] ?? '').split(path.delimiter).filter(Boolean).flatMap(dir => Linux.map(name => path.join(dir, name)))
}

/**
 * Why host windows cannot be shown here, or `undefined` when they can: switched off, no screen (Linux needs `DISPLAY` or
 * `WAYLAND_DISPLAY`), or no Chromium-based browser to run in app mode.
 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { path: string } | { unavailable: string } {
  const off = env['ECMAOS_DISPLAY']
  if (off === '0' || off === 'off' || off === 'false') return { unavailable: 'host windows are turned off (ECMAOS_DISPLAY)' }
  if (platform !== 'darwin' && platform !== 'win32' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY']) {
    return { unavailable: 'this host has no display: DISPLAY and WAYLAND_DISPLAY are not set' }
  }
  const explicit = env['ECMAOS_BROWSER']
  if (explicit) return existsSync(explicit) ? { path: explicit } : { unavailable: `ECMAOS_BROWSER ${explicit} does not exist` }
  const found = candidates(env, platform).find(candidate => existsSync(candidate))
  return found ? { path: found } : { unavailable: 'no Chromium-based browser was found to host windows (set ECMAOS_BROWSER to one)' }
}

/**
 * Runs the system's Chromium-based browser in app mode: one window with no tabs or address bar. A fresh profile
 * directory makes each window its own browser instance, so the window and its process live and die together.
 */
export function browserLauncher(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Launcher {
  const found = findBrowser(env, platform)
  if ('unavailable' in found) return { unavailable: found.unavailable, launch() { throw new Error(found.unavailable) } }
  return {
    launch(url, geometry) {
      const profile = mkdtempSync(path.join(tmpdir(), 'ecmaos-window-'))
      const child = spawn(found.path, [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        `--window-size=${Math.max(100, Math.round(geometry.width))},${Math.max(100, Math.round(geometry.height))}`,
        `--window-position=${Math.round(geometry.x)},${Math.round(geometry.y)}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync'
      ], { stdio: 'ignore', detached: false })
      const exited = new Promise<void>(resolve => {
        const done = () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* in use */ } resolve() }
        child.once('exit', done)
        child.once('error', done)
      })
      child.unref()
      return { kill: () => { child.kill() }, exited }
    }
  }
}
