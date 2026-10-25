#!/usr/bin/env node
// The upstream source of every program in this package, pinned in `programs/manifest.json` (url + sha256) and
// kept in `sources/`. One list serves both jobs: the build scripts under `wasm/` take their input from here, and
// `npm pack` ships the same archives, so the source that is offered is the source the binary was built from.
//
//   node scripts/sources.mjs fetch <program> [source]   download and verify; prints the archive path
//   node scripts/sources.mjs version <program> [source] print the source's version
//   node scripts/sources.mjs all                         fetch everything (what `prepack` runs)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, 'sources')
const { programs } = JSON.parse(readFileSync(path.join(root, 'programs', 'manifest.json'), 'utf8'))

const pick = (program, name = program) => {
  const sources = programs[program]?.sources
  const source = sources?.find(entry => entry.name === name)
  if (!source) throw new Error(`no source "${name}" for program "${program}"`)
  return source
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

/** The bytes at a URL, following redirects. Not `fetch`: gitlab.freedesktop.org answers undici's requests with 406 and node:https' with 200 */
function download(url, redirects = 10) {
  return new Promise((resolve, reject) => {
    get(url, response => {
      const { statusCode = 0, headers } = response
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume()
        if (!redirects) return reject(new Error(`${url}: too many redirects`))
        return resolve(download(new URL(headers.location, url).href, redirects - 1))
      }
      if (statusCode !== 200) {
        response.resume()
        return reject(new Error(`${url}: ${statusCode}`))
      }
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    }).on('error', reject)
  })
}

async function fetchSource(source) {
  const file = path.join(dir, source.archive)
  if (existsSync(file) && sha256(file) === source.sha256) return file
  mkdirSync(dir, { recursive: true })
  const bytes = await download(source.url)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== source.sha256) throw new Error(`${source.archive}: sha256 is ${actual}, the manifest pins ${source.sha256}`)
  writeFileSync(`${file}.part`, bytes)
  renameSync(`${file}.part`, file)
  return file
}

const [command, program, name] = process.argv.slice(2)
if (command === 'fetch') console.log(await fetchSource(pick(program, name)))
else if (command === 'version') console.log(pick(program, name).version)
else if (command === 'all') {
  for (const entry of Object.values(programs)) for (const source of entry.sources ?? []) console.error(`sources: ${await fetchSource(source)}`)
} else {
  console.error('usage: sources.mjs fetch|version <program> [source] | all')
  process.exit(2)
}
