#!/usr/bin/env node
import fs from 'fs'
import { cors } from 'hono/cors'
import { createNodeWebSocket } from '@hono/node-ws'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { spawn } from 'node-pty'
import * as jose from 'jose'

import pkg from '../package.json' with { type: 'json' }

const versions = fs.readdirSync(dirname(fileURLToPath(import.meta.url))).filter(entry => entry.startsWith('v'))
const latestVersion = versions[versions.length - 1]

if (!fs.existsSync('./server.key')) {
  const privateKey = await jose.generateKeyPair('ES384')
  const publicKey = await jose.exportJWK(privateKey.publicKey)
  const privateKeyJWK = await jose.exportJWK(privateKey.privateKey)
  
  fs.writeFileSync('./server.key', JSON.stringify({ privateKey: privateKeyJWK, publicKey }))
}

const authorizedKeys = JSON.parse(fs.readFileSync('./authorized_keys.json', 'utf8'))
const serverKey = JSON.parse(fs.readFileSync('./server.key', 'utf8'))
const app = new Hono()
const processes = new Map<string, any>()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

app.use('*', cors())
app.get('/', (c) => c.json({ name: pkg.name, version: pkg.version, versions, latestVersion }))
app.get('/server.key', (c) => c.json(serverKey.publicKey))
for (const version of versions) app.route(`/${version}`, (await import(`./${version}/${version}.ts`)).default)

// @ts-expect-error
app.get('/socket', upgradeWebSocket(() => {
  return {
    onOpen: (event: Event, ws: WebSocket & { id: string }) => {
      ws.id = crypto.randomUUID()
      ws.send(`${pkg.name}:${pkg.version}:${ws.id}:${btoa(JSON.stringify(serverKey.publicKey))}`)
      console.log(`${ws.id} connected`)
    },
    onClose: (event: CloseEvent, ws: WebSocket & { id: string }) => {
      console.log(`${ws.id} closed`)
      processes.delete(ws.id)
    },
    onMessage: async (message: MessageEvent, ws: WebSocket & { id: string }) => {
      if (processes.has(ws.id)) return processes.get(ws.id).write(message.data)

      const encryptedJWT = message.data
      
      try {
        const privateKey = await jose.importJWK(serverKey.privateKey, 'ES384')
        const decryptedResult = await jose.compactDecrypt(encryptedJWT, privateKey)
        console.log(decryptedResult)
      } catch (error) {
        console.error(error)
      }
    },
    onMessageOld: (message: MessageEvent, ws: WebSocket & { id: string }) => {
      if (processes.has(ws.id)) return processes.get(ws.id).write(message.data)

      try {
        const exec = JSON.parse(decodeURIComponent(message.data))

        switch (exec.command) {
          case 'auth':
            // generate a challenge
            break
          case 'ping':
            ws.send('pong\n')
            break
          case 'echo':
            ws.send(`${exec.args}\n`)
            break
          case 'charstream':
            let interval: any
            let point = 0
            interval = setInterval(() => {
              if (point > 65535) point = 0
              ws.send(String.fromCodePoint(point))
              point++
            }, 10)
            break
          case 'run':
            console.log(`Spawning ${exec.args[0].trim()} with ${exec.args.slice(1).join(' ')}`)

            const username = exec.user
            const publicKey = exec.key
            const userKeys = authorizedKeys[username]
            if (!userKeys) return ws.send(JSON.stringify({ error: 'Unauthorized' }))

            const authorizedKey = userKeys.find((key: any) => key.alg === publicKey.alg && key.use === publicKey.use && key.kid === publicKey.kid && key.kty === publicKey.kty && key.x === publicKey.x && key.y === publicKey.y)
            if (!authorizedKey) return ws.send(JSON.stringify({ error: 'Unauthorized' }))

            const pty = spawn(exec.args[0].trim(), exec.args.slice(1), {
              name: 'xterm-256color',
              cols: exec.cols || 80,
              rows: exec.rows || 24,
              cwd: exec.cwd || process.env.HOME,
              env: exec.env || process.env
            })

            processes.set(ws.id, pty)

            pty.onData((data) => {
              ws.send(data)
            })

            pty.onExit((code) => {
              processes.delete(ws.id)
              console.log(`Process from client ${ws.id} exited with code ${code?.exitCode ?? 'unknown'}`)
              ws.send(`Process from client ${ws.id} exited with code ${code?.exitCode ?? 'unknown'}\n`)
            })

            break
        }
      } catch {}
    }
  }
}))

// Don't expose to any network
const port = Number(process.env.PORT) || 30445
const hostname = process.env.HOSTNAME || 'localhost'
const server = serve({ hostname, port, fetch: app.fetch })
injectWebSocket(server)

console.log(`*** ${pkg.name}:${pkg.version} running on ${hostname}:${port} ***`)
