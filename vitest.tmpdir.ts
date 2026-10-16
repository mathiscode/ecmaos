import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Keeps vitest's and vite's scratch files (the SSR module cache, test temp dirs) under `~/tmp/ecmaos-test` rather than
 * the system temp dir, where stale caches pile up and can fill it. A `TMPDIR` set by the caller is respected.
 * Entries a day old or more are removed, since vitest leaves one behind per run. Importing this module is the whole effect.
 */
if (!process.env.TMPDIR) {
  const dir = join(homedir(), 'tmp', 'ecmaos-test')
  mkdirSync(dir, { recursive: true })
  process.env.TMPDIR = dir
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const name of readdirSync(dir)) {
    try {
      const path = join(dir, name)
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true })
    } catch { /* another run is using or removing it */ }
  }
}
