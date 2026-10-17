import { afterEach, describe, expect, it } from 'vitest'

import { DisplayChannel, MessageStream } from '@ecmaos/peer'
import type { Connection } from '@ecmaos/peer'
import type { ToDisplay } from '@ecmaos/types'

import { Session } from './session.ts'
import { dial, generateKeyPair, login, openShell } from './peer-client.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

const sessions: Session[] = []
const connections: Connection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close()
  await Promise.all(sessions.splice(0).map(session => session.stop()))
})

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(`timed out waiting for ${what}`)
}

/** A machine that listens and, with host windows off, can show a window only on a display that logged in */
async function machine() {
  const session = new Session(['--quiet', '--ephemeral', '--listen=0'], { env: { ...process.env, ECMAOS_DISPLAY: '0' } })
  sessions.push(session)
  await session.ready()
  await session.waitFor('pairing code for')
  const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(session.output)![1])
  const code = /pairing code for (\w+): (\d{3}-\d{3})/.exec(session.output)![2]!
  const connection = await dial(port)
  connections.push(connection)
  await login(connection, 'root', await generateKeyPair(), { code })
  return { connection, shell: await openShell(connection) }
}

async function screen(connection: Connection) {
  const channel = await connection.open(DisplayChannel, { timeout: 5000 })
  const stream = new MessageStream(channel)
  const received: ToDisplay[] = []
  stream.onMessage = value => { received.push(value as unknown as ToDisplay) }
  return { channel, stream, received }
}

const program = (title: string, text: string) => `const s=globalThis.ecmaosSyscalls;const h=await s.custom('window_create','${title}');await s.custom('window_write',h,'${text}');await new Promise(r=>setTimeout(r,60000))`

describe.skipIf(!supported)('the display channel', () => {
  it('shows a window that opens after the display attached, and takes its close request', async () => {
    const { connection, shell } = await machine()
    await shell.waitFor('root:/root# ')
    await shell.run(`echo "${program('Remote one', 'hello remote')}" > /root/w.mjs`)
    const display = await screen(connection)
    await shell.send('node /root/w.mjs &\r')

    await until(() => display.received.some(m => m.t === 'content'), 'the window and its content')
    expect(display.received.find(m => m.t === 'open')).toMatchObject({ t: 'open', title: 'Remote one', geometry: expect.objectContaining({ width: 300 }) })
    const open = display.received.find(m => m.t === 'open') as Extract<ToDisplay, { t: 'open' }>
    expect(display.received.find(m => m.t === 'content')).toMatchObject({ id: open.id, content: { text: 'hello remote' } })
    expect(await shell.run('wmctrl -l')).toContain('Remote one')

    // the user closes it on the screen
    await display.stream.send({ t: 'close-request', id: open.id })
    await until(() => display.received.some(m => m.t === 'close'), 'the close')
    expect(await shell.run('wmctrl -l')).not.toContain('Remote one')
  })

  it('shows what a program writes to its framebuffer as pixels', async () => {
    const { connection, shell } = await machine()
    await shell.waitFor('root:/root# ')
    const display = await screen(connection)
    await shell.send('fbwin -t Pixels 8x4 &\r')
    await until(() => display.received.some(m => m.t === 'open'), 'the framebuffer window')
    expect(display.received.find(m => m.t === 'open')).toMatchObject({ title: 'Pixels' })
    // 8 x 4 pixels of blue, green, red, unused: a red pixel first, then a blue one
    await shell.run('printf "\\000\\000\\177\\000\\177\\000\\000\\000" > /dev/fb0')
    const written = (m: ToDisplay) => m.t === 'content' && 'pixels' in m.content && Buffer.from(m.content.pixels.data, 'base64').some(byte => byte !== 0)
    await until(() => display.received.some(written), 'the frame')
    const frame = display.received.find(written) as Extract<ToDisplay, { t: 'content' }>
    const pixels = (frame.content as { pixels: { width: number, height: number, data: string } }).pixels
    expect([pixels.width, pixels.height]).toEqual([8, 4])
    expect([...Buffer.from(pixels.data, 'base64').subarray(0, 8)]).toEqual([0, 0, 127, 0, 127, 0, 0, 0])
    expect(await shell.run('wmctrl -l')).toContain('Pixels')
  })

  it('announces the windows already open when another display attaches, and ignores messages about others', async () => {
    const { connection, shell } = await machine()
    await shell.waitFor('root:/root# ')
    const first = await screen(connection)
    await shell.run(`echo "${program('Early', 'first')}" > /root/w.mjs`)
    await shell.send('node /root/w.mjs &\r')
    await until(() => first.received.some(m => m.t === 'open'), 'the window on the first display')

    const second = await screen(connection)
    await until(() => second.received.some(m => m.t === 'open'), 'the existing window on the second display')
    const open = second.received.find(m => m.t === 'open') as Extract<ToDisplay, { t: 'open' }>
    expect(open.title).toBe('Early')

    await second.stream.send({ t: 'changed', id: 'not-a-window', title: 'x' })
    await second.stream.send({ t: 'changed', id: open.id, title: 'Renamed' })
    let listing = ''
    for (let i = 0; i < 100 && !listing.includes('Renamed'); i++) { listing = await shell.run('wmctrl -l'); await new Promise(resolve => setTimeout(resolve, 50)) }
    expect(listing).toContain('Renamed')
    expect(listing).not.toContain('not-a-window')
    // closing it on one display closes it on the other
    await second.stream.send({ t: 'close-request', id: open.id })
    await until(() => first.received.some(m => m.t === 'close'), 'the close on the first display')
  })

  it('falls back to nothing, not an error, when the display goes away', async () => {
    const { connection, shell } = await machine()
    await shell.waitFor('root:/root# ')
    const display = await screen(connection)
    display.channel.close()
    await shell.run(`echo "${program('Later', 'x')}" > /root/w.mjs`)
    // host windows are off and nobody is attached: the program gets ENODEV
    expect(await shell.run('node /root/w.mjs 2>&1 | head -3')).toMatch(/ENODEV/)
  })

  it('sends a screen a window\'s content that is larger than the screen may send back', async () => {
    const { connection, shell } = await machine()
    await shell.waitFor('root:/root# ')
    const display = await screen(connection)
    await shell.run(`echo "const s=globalThis.ecmaosSyscalls;const h=await s.custom('window_create','Big');await s.custom('window_write',h,'x'.repeat(300000));await new Promise(r=>setTimeout(r,60000))" > /root/w.mjs`)
    await shell.send('node /root/w.mjs &\r')
    await until(() => display.received.some(m => m.t === 'content'), 'the large content')
    const content = display.received.find(m => m.t === 'content') as Extract<ToDisplay, { t: 'content' }>
    expect('text' in content.content && content.content.text.length).toBe(300000)
  })

  it('is refused to a connection that has not logged in', async () => {
    const session = new Session(['--quiet', '--ephemeral', '--listen=0'], { env: { ...process.env, ECMAOS_DISPLAY: '0' } })
    sessions.push(session)
    await session.ready()
    await session.waitFor('listening on')
    const connection = await dial(Number(/listening on 127\.0\.0\.1:(\d+)/.exec(session.output)![1]))
    connections.push(connection)
    await expect(connection.open(DisplayChannel, { timeout: 3000 })).rejects.toThrow(/no handler|display/)
  })
})
