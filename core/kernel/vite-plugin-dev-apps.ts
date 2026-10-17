/**
 * Dev server only: serves the built bundles of workspace apps as a program catalog (`/dev-apps/index.json`, the shape
 * `installPrograms` reads), so a booting dev machine keeps `/bin/<name>` current with `apps/<app>/dist` instead of
 * running a copy someone pasted in. Production gets its apps from `install`.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

/** Workspace apps (directory names under `apps/`) the dev catalog serves; each needs a `bin` in its package.json */
const apps = ['desktop']

const root = path.resolve(import.meta.dirname, '../../apps')

export function devApps(): Plugin {
  return {
    name: 'ecmaos:dev-apps',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/dev-apps', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')

        if (url.pathname === '/index.json') {
          const packages = []
          for (const app of apps) {
            const bundle = path.join(root, app, 'dist/index.js')
            if (!existsSync(bundle)) continue
            const pkg = JSON.parse(readFileSync(path.join(root, app, 'package.json'), 'utf-8')) as { name: string, version: string, description?: string, bin?: Record<string, string> }
            const bytes = readFileSync(bundle)
            const entry = { file: 'dist/index.js', size: statSync(bundle).size, sha256: createHash('sha256').update(bytes).digest('hex'), version: pkg.version, license: 'MIT', description: pkg.description ?? '' }
            packages.push({ name: pkg.name, path: `/dev-apps/${app}`, programs: Object.fromEntries(Object.keys(pkg.bin ?? {}).map(name => [name, entry])) })
          }
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(JSON.stringify({ packages }))
          return
        }

        const match = /^\/([^/]+)\/dist\/index\.js$/.exec(url.pathname)
        if (match && apps.includes(match[1]!)) {
          const bundle = path.join(root, match[1]!, 'dist/index.js')
          if (existsSync(bundle)) {
            res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(readFileSync(bundle))
            return
          }
        }
        next()
      })
    }
  }
}
