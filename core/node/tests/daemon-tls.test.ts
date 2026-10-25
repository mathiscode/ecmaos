import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Session } from './session.ts'
import { afterAsk, folders, host, sessions, useCleanup } from './daemon-helpers.ts'

useCleanup()

describe('over TLS', () => {
  const Local = 'root:/tmp# '

  /** A self-signed certificate for localhost and 127.0.0.1, and a file the clients can trust it from */
  function certificate() {
    const dir = mkdtempSync(path.join(tmpdir(), 'ecmaosd-tls-'))
    folders.push(dir)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' })
    return { cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') }
  }

  it('listens beyond loopback only with a certificate, and says so', async () => {
    const { cert, key } = certificate()
    const lone = new Session(['--quiet', '--listen=0.0.0.0:0', '--tls-cert', cert])
    sessions.push(lone)
    await lone.ready()
    await lone.waitFor('go together')

    const session = new Session(['--quiet', '--listen=0.0.0.0:0', '--tls-cert', cert, '--tls-key', key])
    sessions.push(session)
    await session.ready()
    await session.waitFor('listening on 0.0.0.0:')
    expect(session.output).toContain('(TLS)')
  })

  it('a machine reaches it with wss://, trusting the certificate; plain ws:// to the same port gets nowhere', async () => {
    const { cert, key } = certificate()
    const { session: remote, port, code } = await host(['--tls-cert', cert, '--tls-key', key, '--device', 'loop=loopback'])
    expect(remote.output).toContain('(TLS)')

    const me = new Session(['--quiet'], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } })
    sessions.push(me)
    await me.ready()
    me.send('cd /tmp\r')
    await me.waitFor(Local)

    const mark = me.output.length
    me.send(`attach -y -p ${code} root@127.0.0.1:${port}/loop plain\r`)
    await me.waitFor('unlocks your key', mark)
    me.send('root\r')
    await me.waitFor(Local, afterAsk(me, mark))
    expect(me.output.slice(mark)).toContain('could not connect')

    const mark2 = me.output.length
    me.send(`attach -y -p ${code} wss://root@localhost:${port}/loop secure\r`)
    await me.waitFor('unlocks your key', mark2)
    me.send('root\r')
    await me.waitFor('Attached loop', mark2)
    await me.waitFor(Local, mark2 + 100)

    // a machine that does not trust the certificate cannot log in at all
    const stranger = new Session(['--quiet'])
    sessions.push(stranger)
    await stranger.ready()
    stranger.send('cd /tmp\r')
    await stranger.waitFor(Local)
    const mark3 = stranger.output.length
    stranger.send(`attach -y -p ${code} wss://root@localhost:${port}/loop x\r`)
    await stranger.waitFor('unlocks your key', mark3)
    stranger.send('root\r')
    await stranger.waitFor(Local, mark3 + 100)
    expect(stranger.output.slice(mark3)).toContain('could not connect')
  })
})
