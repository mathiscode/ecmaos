import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** Ancillary data on local sockets through a real emcc build (`fixtures/emcc-scm.c`): SCM_RIGHTS, SCM_CREDENTIALS, SO_PEERCRED, socketpair. */
describe('an emcc program passing descriptors over local sockets', () => {
  let out: string
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    await kernel.filesystem.fs.writeFile('/tmp/emcc-scm', new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/emcc-scm.wasm`)), { mode: 0o755 })
    expect(await kernel.shell.execute('/tmp/emcc-scm > /tmp/emcc-scm.out 2>&1')).toBe(0)
    out = await kernel.filesystem.fs.readFile('/tmp/emcc-scm.out', 'utf8')
  }, 60_000)

  it('passes a file that is still usable after the sender closed it', () => {
    expect(out).toContain('send-file 1')
    expect(out).toContain('recv-file n=1 fds=1 ctrunc=0')
    expect(out).toContain('file-holds via passed fd')
  })

  it('keeps a pipe from reading as ended while its write end is in flight', () => {
    expect(out).toContain('inflight-read waits')
    expect(out).toContain('inflight-data late')
  })

  it('passes a pipe end, and the pipe stays open until every copy is closed', () => {
    expect(out).toContain('pipe-holds piped')
  })

  it('stops a read at the message that carries a descriptor', () => {
    expect(out).toContain('bound1 n=3 AAA fds=0')
    expect(out).toContain('bound2 n=3 BBB fds=1')
    expect(out).toContain('bound3 n=3 CCC fds=0')
  })

  it('reports truncation and drops what an ordinary read passes over', () => {
    expect(out).toContain('ctrunc n=2 fds=1 ctrunc=1')
    expect(out).toContain('dropped n=1 Y fds=0')
  })

  it('passes a connected socket, with the bytes already in it', () => {
    expect(out).toContain('socket-passed prepost')
    expect(out).toContain('socket-reply reply')
  })

  it('gives the peer credentials, and the sender\'s with each message when asked', () => {
    expect(out).toContain('peercred 1')
    expect(out).toContain('passcred 1')
  })

  it('passes over a named connection', () => {
    expect(out).toContain('named-holds named')
  })

  it('refuses a descriptor that is not open, and rights on a socket that cannot carry them', () => {
    expect(out).toContain('bad-fd -1 EBADF')
    expect(out).toContain('inet-rights -1 EINVAL')
  })

  it('moves a descriptor from one program into another', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    await kernel.filesystem.fs.writeFile('/tmp/scm-peer', new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/emcc-scm-peer.wasm`)), { mode: 0o755 })
    await kernel.shell.execute('/tmp/scm-peer serve /tmp/scm-x.sock > /tmp/scm-serve.out 2>&1 &')
    for (let i = 0; i < 50 && !(await kernel.filesystem.fs.readFile('/tmp/scm-serve.out', 'utf8')).includes('listening'); i++) await new Promise(resolve => setTimeout(resolve, 100))
    expect(await kernel.shell.execute('/tmp/scm-peer send /tmp/scm-x.sock /tmp/scm-peer-file > /tmp/scm-send.out 2>&1')).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/scm-send.out', 'utf8')).toContain('answer done')
    expect(await kernel.filesystem.fs.readFile('/tmp/scm-peer-file', 'utf8')).toBe('written by the receiver')
  }, 60_000)
})
