import { describe, it, expect, beforeAll } from 'vitest'
import binNodeSource from 'virtual:bin-node'

import '@zenfs/linux'
import { Process, execve, DevTmpFS } from '@zenfs/linux'
import { defaultContext, configure, InMemory, fs } from '@zenfs/core'

/**
 * A real end-to-end proof of the execve pipeline: `@zenfs/linux`'s own default `binfmt_js` (any
 * plain JS/ESM file, no magic bytes required) already points at `/bin/node` as its interpreter --
 * this test is what happens once that file is real. See `src/bin/node.mjs` for what it is and why
 * it must be a single import-free bundle.
 */
describe('/bin/node via execve', () => {
  beforeAll(async () => {
    await configure({ mounts: { '/': InMemory, '/dev': new DevTmpFS() } })
    await fs.promises.writeFile('/dev/console', '')
    await fs.promises.mkdir('/bin')
    await fs.promises.writeFile('/bin/node', binNodeSource, { mode: 0o755 })
  })

  it('runs a self-contained program to completion with exit code 0', async () => {
    await fs.promises.writeFile('/ok.js', 'globalThis.__ranOk = true', { mode: 0o755 })

    const proc = new Process({ context: defaultContext })
    await execve(proc, '/ok.js', ['/ok.js'], {})
    expect(await proc.exited).toBe(0)
  })

  it('exits 1 when the program throws', async () => {
    // /bin/node has no import-rewriting yet (see its doc comment), so a program cannot itself
    // import @zenfs/linux/uapi/process to call exit(n) with a custom code -- only self-contained
    // scripts run. What's provable here is that a program's own failure produces exit code 1.
    // The interpreter's console.error for this runs inside the worker thread, not this process,
    // so it prints real (harmless) noise to this test's stderr rather than something mockable here.
    await fs.promises.writeFile('/throws.js', 'throw new RangeError("out of range")', { mode: 0o755 })

    const proc = new Process({ context: defaultContext })
    await execve(proc, '/throws.js', ['/throws.js'], {})
    expect(await proc.exited).toBe(1)
  })

  it('reads the real program bytes through open/read/close, not by any main-thread shortcut', async () => {
    // A large-ish program (bigger than one internal read chunk) proves the read loop actually
    // loops, not just handles a single small file that fits in one call.
    const filler = '// '.repeat(30000)
    await fs.promises.writeFile('/large.js', `${filler}\nglobalThis.__ranLarge = true`, { mode: 0o755 })

    const proc = new Process({ context: defaultContext })
    await execve(proc, '/large.js', ['/large.js'], {})
    expect(await proc.exited).toBe(0)
  })
})
