import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { ptyIndices } from '#lib/pty.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `/dev/ptmx` and `/dev/pts/<n>`, driven the way a terminal emulator or a shell in a worker would. */
describe('pseudo-terminals', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  const fs = () => kernel.filesystem.fs
  const program = async (name: string, body: string) => {
    await fs().rm('/tmp/pty-result', { force: true })
    await fs().writeFile(`/tmp/${name}.js`, `
      const { open, close, read, write, ioctl, O_RDWR = 2 } = globalThis.ecmaosSyscalls
      const enc = new TextEncoder(), dec = new TextDecoder()
      const out = []
      const say = text => out.push(text)
      ${body}
      const fd = open('/tmp/pty-result', 1 | 64 | 512, 0o644)
      write(fd, enc.encode(out.join('|')))
      close(fd)
    `, { mode: 0o755 })
    const code = await kernel.shell.execute(`/tmp/${name}.js`)
    return { code, result: await fs().readFile('/tmp/pty-result', 'utf-8').catch(() => '') }
  }

  it('opening /dev/ptmx makes a slave under /dev/pts', async () => {
    await fs().rm('/tmp/pty-result', { force: true })
    const { code, result } = await program('alloc', `
      const master = open('/dev/ptmx', 2, 0)
      say('master=' + (master >= 3))
      close(master)
    `)
    expect(code).toBe(0)
    expect(result).toBe('master=true')
    expect(ptyIndices()).toEqual([])
  })

  it('bytes written to the master arrive on the slave, and the slave answers', async () => {
    const { result } = await program('io', `
      const { readdir } = globalThis.ecmaosSyscalls
      const master = open('/dev/ptmx', 2, 0)
      const names = readdir('/dev/pts').filter(n => !n.startsWith('.'))
      say('slaves=' + names.join(','))
      const slave = open('/dev/pts/' + names[0], 2, 0)
      write(master, enc.encode('hello\\n'))
      const buf = new Uint8Array(64)
      const n = read(slave, buf, -1)
      say('slave-read=' + JSON.stringify(dec.decode(buf.subarray(0, n))))
      write(slave, enc.encode('reply'))
      const heard = []
      for (;;) {
        const m = read(master, buf, -1)
        heard.push(dec.decode(buf.subarray(0, m)))
        if (heard.join('').includes('reply')) break
      }
      say('master-read=' + JSON.stringify(heard.join('')))
      close(slave); close(master)
    `)
    expect(result).toBe('slaves=0|slave-read="hello\\n"|master-read="hello\\r\\nreply"')
  })

  it('TIOCPKT puts a status byte, 0 for data, in front of what the master reads', async () => {
    const { result } = await program('packet', `
      const { readdir } = globalThis.ecmaosSyscalls
      const master = open('/dev/ptmx', 2, 0)
      const names = readdir('/dev/pts').filter(n => !n.startsWith('.'))
      const slave = open('/dev/pts/' + names[0], 2, 0)
      const buf = new Uint8Array(64)
      say('plain=' + ioctl(master, 0x80045438))
      ioctl(master, 0x5420, 1)
      say('packet=' + ioctl(master, 0x80045438))
      write(slave, enc.encode('reply'))
      const n = read(master, buf, -1)
      say('read=' + JSON.stringify(Array.from(buf.subarray(0, n))))
      close(slave); close(master)
    `)
    expect(result).toBe('plain=0|packet=1|read=[0,114,101,112,108,121]')
  })

  it('closing the master frees the pair and takes its slave away', async () => {
    const { result } = await program('gone', `
      const master = open('/dev/ptmx', 2, 0)
      close(master)
      const { readdir } = globalThis.ecmaosSyscalls
      let left = 0
      try { left = readdir('/dev/pts').filter(n => !n.startsWith('.')).length } catch { /* the directory goes with its last node */ }
      say('left=' + left)
    `)
    expect(result).toBe('left=0')
    expect(ptyIndices()).toEqual([])
  })
})
