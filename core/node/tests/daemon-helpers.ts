import { afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import net from 'node:net'

import type { Connection } from '@ecmaos/peer'

import { Session } from './session.ts'
import { dial } from './peer-client.ts'
import { copyOfTemplate, FixtureDir } from './template.ts'

export const sessions: Session[] = []
export const connections: Connection[] = []
export const folders: string[] = []
/** Things a test opened (servers) that are closed after it */
export const afterEachClose: Array<() => void> = []

/** Closes what a test opened, in the test file that calls it */
export function useCleanup() {
  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close()
    for (const close of afterEachClose.splice(0)) close()
    await Promise.all(sessions.splice(0).map(session => session.stop()))
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
}


/** Starts a machine listening on a free port and reads what it printed */
export async function host(extra: string[] = [], data?: string) {
  const env = data ? { ...process.env, ECMAOS_DATA: data } : undefined
  const session = new Session(['--quiet', '--listen=0', ...extra], { env })
  sessions.push(session)
  await session.ready()
  await session.waitFor('host key SHA256:')
  if (!extra.includes('--no-pair')) await session.waitFor('pairing code for')
  const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(session.output)![1])
  const fingerprint = /host key (SHA256:\S+)/.exec(session.output)![1]!
  const code = /pairing code for (\w+): (\d{3}-\d{3})/.exec(session.output)?.[2]
  return { session, port, fingerprint, code }
}

export const connect = async (port: number, options?: Parameters<typeof dial>[1]) => {
  const connection = await dial(port, options)
  connections.push(connection)
  return connection
}

/** Where the password question ends: the first prompt after this is the command's own, not one from before it or inside its echo */
export function afterAsk(me: Session, mark: number) {
  const at = me.output.indexOf('unlocks your key', mark)
  return at === -1 ? mark : at
}

/** A TCP server that answers in upper case; the port it listens on */
export async function echoServer(once = false) {
  const server = net.createServer(socket => socket.on('data', chunk => { socket.write(chunk.toString().toUpperCase()); if (once) socket.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  afterEachClose.push(() => server.close())
  return (server.address() as net.AddressInfo).port
}

export async function unusedPort() {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

/** Puts one of the test programs of `fixtures/` at `destination` in a session's machine (the template has them all) */
export async function install(me: Session, fixture: string, destination: string) {
  await me.run(`cp ${FixtureDir}/${fixture} ${destination}`)
}

export async function bringUp(me: Session, port: number, code: string | undefined) {
  const mark = me.output.length
  me.send(`gateway up root@127.0.0.1:${port} --pair ${code} -y\r`)
  await me.waitFor('unlocks your key', mark)
  me.send('root\r')
  await me.waitFor('is up as root', mark)
  await me.waitFor('root:/root# ', me.output.indexOf('is up as root', mark))
}

/** A data folder for a machine that is to be started more than once or given files beforehand; it has booted before, and is removed after the test */
export function dataFolder(prefix = 'ecmaosd-data-') {
  const folder = copyOfTemplate(prefix)
  folders.push(folder)
  return folder
}
