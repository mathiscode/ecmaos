import { beforeAll, describe, expect, it } from 'vitest'
import { Class } from '@zenfs/linux'
import { sessionOperations } from '@ecmaos-devices/session'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** SDL 3's audio through the ecmaOS driver (`fixtures/sdl-audio.c`), with a `/dev/dsp1` that keeps what is played. */
describe('SDL audio', () => {
  let kernel: Kernel
  const played: Uint8Array[] = []
  const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf8').catch(() => '')

  beforeAll(async () => {
    const speakers = {
      pkg: { name: 'audio', version: '0', description: 'a speaker that keeps what it is given' },
      getDrivers: async () => [{
        name: 'dsp1', major: 14, minor: 19, class: new Class('audio'),
        ops: sessionOperations({ open: async () => ({ info: { kind: 'audio-out', read: false, write: true }, write: async (data: Uint8Array) => { played.push(data) }, close: async () => {} }) })
      }]
    }
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, devices: { audio: speakers as never } })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    await kernel.filesystem.fs.writeFile('/bin/sdl-audio', new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/sdl-audio.wasm`)), { mode: 0o755 })
  }, 60_000)

  it('plays a program\'s sound as 48000 Hz stereo to /dev/dsp1, paced by the clock', async () => {
    const started = Date.now()
    const code = await kernel.shell.execute('sdl-audio 600 > /tmp/sdl-audio.out 2>&1')
    const elapsed = Date.now() - started
    const out = await read('/tmp/sdl-audio.out')
    expect(code).toBe(0)
    expect(out).toContain('driver=ecmaos')
    expect(out).toContain('device=48000 Hz 2 channels format=0x8010')
    expect(out).toContain('fed=yes')
    expect(out).toContain('done')

    const bytes = played.reduce((sum, chunk) => sum + chunk.length, 0)
    const seconds = bytes / (48000 * 4)
    // 600 ms of running, up to 100 ms kept ahead of the clock
    expect(seconds).toBeGreaterThan(0.5)
    expect(seconds).toBeLessThan((elapsed + 200) / 1000)

    // the tone is there: 440 Hz at half scale, the same in both channels
    const all = new Uint8Array(bytes)
    let at = 0
    for (const chunk of played) { all.set(chunk, at); at += chunk.length }
    const samples = new Int16Array(all.buffer, 0, Math.floor(bytes / 2))
    let peak = 0
    let different = 0
    for (let i = 0; i + 1 < samples.length; i += 2) {
      peak = Math.max(peak, Math.abs(samples[i]!))
      if (samples[i] !== samples[i + 1]) different++
    }
    expect(peak).toBeGreaterThan(14000)
    expect(peak).toBeLessThan(18000)
    expect(different).toBe(0)
  }, 60_000)
})
