import '../../vitest.tmpdir.mts'
import { defineConfig } from 'vitest/config'

/**
 * The site in a real browser: the built kernel (`pnpm build` first) served by `vite preview`, booted in headless
 * Chromium by Playwright, and driven from the keyboard. What jsdom and the Node project cannot check: WinBox windows,
 * a canvas the page draws, WebGL2, and a WASI Preview 2 component on the browser's JSPI and jco's browser build.
 *
 *   pnpm --filter @ecmaos/kernel build && pnpm --filter @ecmaos/kernel test:e2e
 *
 * Playwright's Chromium has to be installed once: `npx playwright install chromium`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    // a first boot installs the initfs and the programs into an empty profile, which takes a minute or more
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})
