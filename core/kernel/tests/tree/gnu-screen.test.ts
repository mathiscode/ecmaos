import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { createPty } from '#lib/pty.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** A Web Serial port with an Arduino's ids that a test can feed, and that records what is written to it */
class FakePort {
  opened: { baudRate: number } | undefined
  written: number[] = []
  private controller!: ReadableStreamDefaultController<Uint8Array>
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  async open(options: { baudRate: number }) {
    this.opened = options
    this.readable = new ReadableStream({ start: controller => { this.controller = controller } })
    this.writable = new WritableStream({ write: chunk => { this.written.push(...chunk) } })
  }
  async close() { this.opened = undefined }
  getInfo() { return { usbVendorId: 0x2341, usbProductId: 0x43 } }
  async getSignals() { return { dataSetReady: true, clearToSend: true, dataCarrierDetect: false, ringIndicator: false } }
  async setSignals() {}
  feed(text: string) { this.controller.enqueue(new TextEncoder().encode(text)) }
}

const until = async (done: () => boolean, tries = 4000) => {
  for (let i = 0; i < tries && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  if (!done()) throw new Error('timed out')
}

describe('GNU screen', () => {
  let kernel: Kernel
  const port = new FakePort()
  const fs = () => kernel.filesystem.fs

  beforeAll(async () => {
    Object.defineProperty(globalThis.navigator, 'serial', {
      value: { getPorts: async () => [port], addEventListener() {}, removeEventListener() {} },
      configurable: true
    })
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  })

  /** screen on a terminal, as a terminal window runs it; what it writes to the terminal is collected */
  const run = async (...args: string[]) => {
    const pty = createPty()
    let seen = ''
    pty.onData(data => { seen += new TextDecoder().decode(data) })
    const proc = await kernel.spawnOnPty({ username: 'root', pty, command: '/bin/screen', args })
    return { pty, proc, seen: () => seen, clear: () => { seen = '' } }
  }

  /** What a command prints to a file, for a command that prints rather than draws */
  const output = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/screen.out 2>&1`)
    return { code, text: await fs().readFile('/tmp/screen.out', 'utf8') }
  }

  it('screen -v gives its version', async () => {
    const { text } = await output('screen -v')
    expect(text).toMatch(/^Screen version 5\.0\.1 /)
  }, 60000)

  it('a window runs a shell; ^A d detaches it and leaves a socket that -ls shows and -r returns to', async () => {
    const first = await run('-S', 'demo')
    await until(() => first.seen().includes('$ '))
    first.clear()
    first.pty.write('echo sum-$((6*7))\r')
    await until(() => first.seen().includes('sum-42'))
    first.pty.write('\x01d')
    await until(() => first.seen().includes('[detached from '))
    await first.proc.exited

    // bind made a socket file where Linux would: screen's own listing finds it by its type
    const socket = (await fs().readdir('/root/.screen')).find(name => name.endsWith('.demo'))
    expect(socket).toBeDefined()
    expect((await fs().stat(`/root/.screen/${socket}`)).isSocket()).toBe(true)
    expect((await output('screen -ls')).text).toContain(`${socket}\t(Detached)`)

    // the window kept what it showed, and takes input again
    const again = await run('-r', 'demo')
    await until(() => again.seen().includes('sum-42'))
    again.clear()
    again.pty.write('echo back-$((6*7))\r')
    await until(() => again.seen().includes('back-42'))

    // -X sends a command to the session: this one ends it, and the socket goes with it
    expect((await output('screen -S demo -X quit')).code).toBe(0)
    await again.proc.exited
    for (let i = 0; i < 400 && (await fs().readdir('/root/.screen')).some(name => name.endsWith('.demo')); i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect((await output('screen -ls')).text).toContain('No Sockets found')
    first.pty.close()
    again.pty.close()
  }, 120000)

  it('screen /dev/ttyACM0 115200: what the board says is shown, what is typed goes to the board', async () => {
    port.written = []
    const session = await run('-S', 'board', '/dev/ttyACM0', '115200')
    await until(() => port.opened?.baudRate === 115200)
    // the port was taken as a terminal program takes it (TIOCEXCL, then the speed), with nothing refused
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(session.seen()).not.toContain('failed')
    port.feed('hello from the board\r\n')
    await until(() => session.seen().includes('hello from the board'))
    session.pty.write('AT\r')
    await until(() => port.written.length >= 3)
    expect(new TextDecoder().decode(new Uint8Array(port.written))).toBe('AT\r')
    // ^A k kills the window, y confirms, and the last window ending ends screen
    session.pty.write('\x01k')
    await until(() => session.seen().includes('Really kill this window'))
    session.pty.write('y')
    await session.proc.exited
    await until(() => port.opened === undefined)
    session.pty.close()
  }, 120000)
})
