import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * UDP between programs on this machine through `sendmsg`/`recvmsg`, and one unbound socket sending to two peers. The program is a real
 * emcc build (`fixtures/emcc-udp-msg.c`); nothing here needs a gateway.
 */
describe('an emcc program using sendmsg/recvmsg on UDP sockets', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  it('gathers and scatters iovecs, names the sender, and lets one unbound socket talk to two peers', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/emcc-udp-msg.wasm`)
    await kernel.filesystem.fs.writeFile('/tmp/emcc-udp-msg', new Uint8Array(bytes), { mode: 0o755 })
    expect(await kernel.shell.execute('/tmp/emcc-udp-msg > /tmp/emcc-udp-msg.out 2>&1')).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/emcc-udp-msg.out', 'utf8')
    expect(out).toContain('[hel][lo] from 127.0.0.1')
    expect(out).toContain('two got 6 = [sec][ond] from 127.0.0.1')
    const replies = [...out.matchAll(/client got \[(\w+)\] from port (\d+) \(namelen 16, control 0\)/g)]
    expect(replies.map(match => match[1]).sort()).toEqual(['HELLO', 'SECOND'])
    expect(replies.map(match => match[2]).sort()).toEqual(['5401', '5402'])
    // beyond this machine with no gateway: a send error, not a datagram lost on the way (ENETUNREACH is 40 in emscripten's errno numbering, as for connect())
    expect(out).toMatch(/far -1 errno 40/)
  }, 60_000)
})
