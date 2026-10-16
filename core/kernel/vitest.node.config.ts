import '../../vitest.tmpdir.mts'
import { defineConfig, mergeConfig } from 'vitest/config'
import type { Plugin } from 'vite'

import base from './vite.config.ts'

/**
 * The kernel tests on real Node, with no DOM: what the `@ecmaos/node` host runs on. It reuses the main config's
 * plugins and aliases and swaps the environment and setup. Everything under `tests/` is in, except the files named in
 * `DomBound` below, which need a page and stay in the jsdom project.
 *
 *   pnpm --filter @ecmaos/kernel test:node
 */
export const DomBound: Record<string, string> = {
  // a real page: DOM classes, `window`, or a rendered terminal
  'tests/tree/dom.test.ts': 'the DOM helpers (topbar, toasts)',
  'tests/tree/windows.test.ts': 'WinBox windows',
  'tests/tree/presenters.test.ts': 'stubs `window.matchMedia` and the presentation API',
  'tests/tree/kernel-commands-execve.test.ts': 'commands that build `HTMLInputElement`s',
  'tests/tree/tar-rm-initfs.test.ts': 'one test stubs `window`',
  'tests/tree/worker-syscall-bridge.test.ts': 'a program that opens a WinBox window',
  'tests/tree/init-script.test.ts': 'the screensaver daemon draws on a canvas',
  'tests/tree/shell-variable-scope.test.ts': '`createShell` reads `document`',
  'tests/tree/terminal.test.ts': '`switchTty` and the rendered terminal use `document`',
  'tests/tree/tier-c-execve.test.ts': 'a command that needs `document` and WebAuthn',
  'tests/tree/boot-getty.test.ts': 'logging in on the other terminals switches the visible tty',
  // spies on browser objects (`window.close`, `navigator.*`), or devices that wrap browser APIs
  'tests/tree/app-runner.test.ts': 'spies on a global the browser has',
  'tests/tree/boot-failure.test.ts': 'spies on a global the browser has',
  'tests/tree/init-reboot-shortcut.test.ts': 'spies on `window.close`',
  'tests/tree/device-cli.test.ts': '`/dev/battery` is the Battery API',
  'tests/tree/device-manifest-policy.test.ts': '`/dev/battery` is the Battery API',
  'tests/tree/host-seams.test.ts': 'checks `/dev/battery`',
  // xterm's own key handling, which needs an opened terminal
  'tests/tree/shell-jobs-execve.test.ts': '`^C` arrives through xterm\'s key events',
  'tests/tree/ecmash.test.ts': 'mounts a second terminal on the same tty',
  'tests/tree/shell-builtins.test.ts': 'mounts a second terminal on the same tty'
}

/** `document.createElement(...)` and `document.body.appendChild(...)` in a test become calls on the stand-in page (see `tests/setup-node.ts`) */
const standInPage: Plugin = {
  name: 'ecmaos:node-test-page',
  enforce: 'pre',
  transform(code, id) {
    if (!/\/tests\/.*\.test\.ts$/.test(id) || !code.includes('document.')) return
    return code.replace(/\bdocument\.(createElement|body\.appendChild)\(/g, 'globalThis.__page.$1(')
  }
}

const merged = mergeConfig(base, defineConfig({
  plugins: [standInPage],
  // Each file boots a kernel and spawns a worker per program, so a loaded machine occasionally trips a timing-sensitive
  // test (a different one each run, none failing alone); the main config pins its worker count for the same reason.
  // One retry keeps that from failing CI, and a test that fails twice still fails.
  test: { environment: 'node', retry: 1, include: ['tests/**/*.test.ts'], exclude: ['**/node_modules/**', '**/*.slow.test.ts', ...(process.env['CORPUS'] ? [] : ['**/*.corpus.test.ts']), ...Object.keys(DomBound)] }
}))

// `mergeConfig` joins arrays, which would keep the jsdom setup file; this project has its own
merged.test!.setupFiles = ['./tests/setup-node.ts']

export default merged
