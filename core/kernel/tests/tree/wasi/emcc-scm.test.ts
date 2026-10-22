import { beforeAll, describe, expect, it } from 'vitest'
import { processes } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * Ancillary data on local sockets through a real emcc build (`fixtures/emcc-scm.c`): SCM_RIGHTS, SCM_CREDENTIALS,
 * SO_PEERCRED, socketpair. The same programs built on WALI's musl (`fixtures/wali.build.sh`) run with the same
 * assertions.
 */
describe.each(['emcc', 'wali'])('the %s build passing descriptors over local sockets', abi => {
  let out: string
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    await kernel.filesystem.fs.writeFile(`/tmp/${abi}-scm`, new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${abi}-scm.wasm`)), { mode: 0o755 })
    expect(await kernel.shell.execute(`/tmp/${abi}-scm > /tmp/${abi}-scm.out 2>&1`)).toBe(0)
    out = await kernel.filesystem.fs.readFile(`/tmp/${abi}-scm.out`, 'utf8')
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
    await kernel.filesystem.fs.writeFile(`/tmp/${abi}-scm-peer`, new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${abi}-scm-peer.wasm`)), { mode: 0o755 })
    await kernel.shell.execute(`/tmp/${abi}-scm-peer serve /tmp/${abi}-scm-x.sock > /tmp/${abi}-scm-serve.out 2>&1 &`)
    for (let i = 0; i < 50 && !(await kernel.filesystem.fs.readFile(`/tmp/${abi}-scm-serve.out`, 'utf8')).includes('listening'); i++) await new Promise(resolve => setTimeout(resolve, 100))
    expect(await kernel.shell.execute(`/tmp/${abi}-scm-peer send /tmp/${abi}-scm-x.sock /tmp/${abi}-scm-peer-file > /tmp/${abi}-scm-send.out 2>&1`)).toBe(0)
    expect(await kernel.filesystem.fs.readFile(`/tmp/${abi}-scm-send.out`, 'utf8')).toContain('answer done')
    expect(await kernel.filesystem.fs.readFile(`/tmp/${abi}-scm-peer-file`, 'utf8')).toBe('written by the receiver')
  }, 60_000)
})

/**
 * Between the two builds: an emcc program's descriptors travel beside the stream and a WALI program's in its socket's
 * pipe, so the kernel hands them across (a WALI Wayland client and the emcc compositor pass the keymap and wl_shm pools)
 */
describe.each([['emcc', 'wali'], ['wali', 'emcc']])('a descriptor from a %s program to a %s one', (sender, receiver) => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    const { readFileSync } = process.getBuiltinModule('node:fs')
    for (const abi of new Set([sender, receiver])) {
      await kernel.filesystem.fs.writeFile(`/tmp/${abi}-scm-peer`, new Uint8Array(readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${abi}-scm-peer.wasm`)), { mode: 0o755 })
    }
  })

  it('is received, and the receiver writes through it; the sender takes the answer with recvmsg, and SO_PEERCRED names the receiver', async () => {
    await kernel.shell.execute(`/tmp/${receiver}-scm-peer serve /tmp/x.sock > /tmp/serve.out 2>&1 &`)
    for (let i = 0; i < 50 && !(await kernel.filesystem.fs.readFile('/tmp/serve.out', 'utf8')).includes('listening'); i++) await new Promise(resolve => setTimeout(resolve, 100))
    // the kernel's number for it (an Emscripten program built without libecmaos has 42 for its own)
    const pid = [...processes.values()].find(proc => proc.argv.includes('serve') && proc.code === undefined)!.pid
    expect(await kernel.shell.execute(`/tmp/${sender}-scm-peer send /tmp/x.sock /tmp/peer-file > /tmp/send.out 2>&1`)).toBe(0)
    expect(await kernel.filesystem.fs.readFile('/tmp/send.out', 'utf8')).toBe(`answer done\npeer pid ${pid}\n`)
    expect(await kernel.filesystem.fs.readFile('/tmp/peer-file', 'utf8')).toBe('written by the receiver')
  }, 60_000)
})
