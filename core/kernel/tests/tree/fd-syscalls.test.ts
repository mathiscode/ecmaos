import { describe, it, expect, beforeAll } from 'vitest'
import binNodeSource from 'virtual:bin-node'

import '@zenfs/linux'
import { Process, execve, DevTmpFS } from '@zenfs/linux'
import { defaultContext, configure, InMemory, fs } from '@zenfs/core'

/**
 * `pipe`, `dup` and `dup2` reach a worker program through `ecmaosSyscalls`. Same setup as
 * `bin-node-execve.test.ts`: the program is a plain script run by `/bin/node`, and reports through a
 * file since it has no terminal here.
 */
describe('pipe, dup and dup2 in a worker program', () => {
  beforeAll(async () => {
    await configure({ mounts: { '/': InMemory, '/dev': new DevTmpFS() } })
    await fs.promises.writeFile('/dev/console', '')
    await fs.promises.mkdir('/bin')
    await fs.promises.writeFile('/bin/node', binNodeSource, { mode: 0o755 })
  })

  const run = async (name: string, source: string) => {
    await fs.promises.writeFile(`/${name}.js`, source, { mode: 0o755 })
    const proc = new Process({ context: defaultContext })
    await execve(proc, `/${name}.js`, [`/${name}.js`], {})
    return await proc.exited
  }

  const report = `
    const { open, write, close, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
    const say = text => { const fd = open('/result', O_WRONLY | O_CREAT | O_TRUNC, 0o644); write(fd, new TextEncoder().encode(text)); close(fd) }
  `

  it('moves bytes through a pipe and through a dup of its write end', async () => {
    const code = await run('pipe', `${report}
      const { pipe, dup, read } = globalThis.ecmaosSyscalls
      const [r, w] = pipe()
      const w2 = dup(w)
      write(w, new TextEncoder().encode('ab'))
      write(w2, new TextEncoder().encode('cd'))
      close(w); close(w2)
      const buffer = new Uint8Array(16)
      const n = read(r, buffer, -1)
      say(new TextDecoder().decode(buffer.subarray(0, n)))
    `)
    expect(code).toBe(0)
    expect(await fs.promises.readFile('/result', 'utf-8')).toBe('abcd')
  })

  it('dup2 puts a descriptor at the number asked for', async () => {
    const code = await run('dup2', `${report}
      const { pipe, dup2, read } = globalThis.ecmaosSyscalls
      const [r, w] = pipe()
      const at = dup2(w, 40)
      write(40, new TextEncoder().encode('via40'))
      const buffer = new Uint8Array(16)
      const n = read(r, buffer, -1)
      say(at + ':' + new TextDecoder().decode(buffer.subarray(0, n)))
    `)
    expect(code).toBe(0)
    expect(await fs.promises.readFile('/result', 'utf-8')).toBe('40:via40')
  })
})
