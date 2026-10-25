/**
 * Builds the in-tree kernel modules (`modules/NAME/`) into `public/modules/NAME.ko.mjs` and the catalog the kernel fetches
 * them from on first use (`public/modules/index.json`). A module's source is `index.ts` (default export `{ init, exit? }`)
 * and `module.json` (its modinfo). The libraries the kernel runs on (`src/tree/lib/module-libs.json`: ZenFS and its
 * helpers) are not bundled: the module takes them from the kernel, so it and the kernel use the same classes. Anything else
 * it imports is bundled in.
 *
 * Signing: with ECMAOS_MODULE_KEY set to a private key file (made by `node scripts/module-key.mjs`), each module gets an
 * Ed25519 signature trailer, as `sign-module` writes. ECMAOS_MODULE_SIGNER names the signer (default `ecmaos`).
 *
 *   node scripts/build-modules.mjs [OUTDIR]
 */

import { build } from 'esbuild'
import { createHash, webcrypto } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(path.join(root, 'package.json'))
const libs = JSON.parse(readFileSync(path.join(root, 'src/tree/lib/module-libs.json'), 'utf8'))
const LIBRARY = /^(@zenfs\/core|kerium|utilium|memium)(\/|$)/

const toBase64 = bytes => Buffer.from(bytes).toString('base64')
const fromBase64Url = text => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const hex = bytes => Buffer.from(bytes).toString('hex')

/** Stands in for a kernel library: the module reads it from the kernel when it starts (`__lib` is defined by the wrapper) */
function kernelLibraries() {
  return {
    name: 'ecmaos-kernel-libraries',
    setup(builder) {
      builder.onResolve({ filter: LIBRARY }, args => {
        if (!libs.includes(args.path)) {
          return { errors: [{ text: `${args.path} is not one of the libraries the kernel gives modules (src/tree/lib/module-libs.json)` }] }
        }
        return { path: args.path, namespace: 'kernel-library' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'kernel-library' }, async args => {
        const real = await import(import.meta.resolve(args.path))
        const names = Object.keys(real).filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name))
        const contents = `const library = __lib(${JSON.stringify(args.path)})\nexport const { ${names.join(', ')} } = library\n${'default' in real ? 'export default library.default\n' : ''}`
        return { contents, loader: 'js', resolveDir: root }
      })
    }
  }
}

async function sign(body, keyFile, signer) {
  const jwk = JSON.parse(readFileSync(keyFile, 'utf8'))
  const key = await webcrypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign'])
  const signature = new Uint8Array(await webcrypto.subtle.sign('Ed25519', key, Buffer.from(body)))
  const id = hex(createHash('sha256').update(fromBase64Url(jwk.x)).digest().subarray(0, 8))
  return `/* ecmaos-module-signature\n * signer=${signer}\n * key_id=${id}\n * sig=${toBase64(signature)}\n */\n`
}

export async function buildModules({ out = path.join(root, 'public/modules'), key = process.env.ECMAOS_MODULE_KEY, signer = process.env.ECMAOS_MODULE_SIGNER ?? 'ecmaos' } = {}) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  mkdirSync(out, { recursive: true })
  const built = new Set()
  // a reader (a test, a dev server, the node build) may be fetching while this runs, so a file is replaced in one step
  const put = (file, text) => {
    const temp = path.join(out, `.${file}.${process.pid}.tmp`)
    writeFileSync(temp, text)
    renameSync(temp, path.join(out, file))
  }
  const catalog = { modules: {} }

  for (const name of readdirSync(path.join(root, 'modules'), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(path.join(root, 'modules', entry.name, 'module.json'))).map(entry => entry.name).sort()) {
    const dir = path.join(root, 'modules', name)
    const info = JSON.parse(readFileSync(path.join(dir, 'module.json'), 'utf8'))
    const result = await build({
      entryPoints: [path.join(dir, 'index.ts')],
      bundle: true,
      format: 'iife',
      globalName: '__m',
      platform: 'browser',
      target: 'es2022',
      write: false,
      legalComments: 'none',
      plugins: [kernelLibraries()],
      logLevel: 'silent'
    })
    const bundle = result.outputFiles[0].text.replace(/^\s*var __m = /, 'const __m = ')

    const header = [
      '/* ecmaos-module',
      ` * name=${info.name}`,
      ` * version=${info.version ?? version}`,
      ...(info.description ? [` * description=${info.description}`] : []),
      ...(info.license ? [` * license=${info.license}`] : []),
      ' * kernel_api=^1.0.0',
      ...(info.author ?? []).map(author => ` * author=${author}`),
      ...(info.depends?.length ? [` * depends=${info.depends.join(',')}`] : []),
      ...(info.alias ?? []).map(alias => ` * alias=${alias}`),
      ' */'
    ].join('\n')
    const body = `${header}\n// Built from modules/${name} by scripts/build-modules.mjs\n// The bundle runs once, however often the module is loaded: the kernel keeps the module it evaluated, and a library inside\n// it may register types that cannot be registered twice\nlet impl\nexport default {\n  async init(ctx) {\n    if (!impl) {\n      const __lib = spec => ctx.import('lib:' + spec)\n${bundle}\n      impl = __m.default\n    }\n    await impl.init(ctx)\n  },\n  async exit() { await impl?.exit?.() }\n}\n`
    const text = key ? body + await sign(body, key, signer) : body
    const file = `${name}.ko.mjs`
    put(file, text)
    built.add(file)
    catalog.modules[name] = {
      file,
      size: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
      version: info.version ?? version,
      license: info.license ?? '',
      description: info.description ?? '',
      aliases: info.alias ?? [],
      depends: info.depends ?? [],
      signed: !!key
    }
  }

  put('index.json', JSON.stringify(catalog, null, 2) + '\n')
  // a module that is gone from the tree is gone from the catalog and the directory
  for (const stale of readdirSync(out).filter(file => file.endsWith('.ko.mjs') && !built.has(file))) rmSync(path.join(out, stale))
  return catalog
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = await buildModules({ out: process.argv[2] ? path.resolve(process.argv[2]) : undefined })
  for (const [name, entry] of Object.entries(catalog.modules)) console.log(`modules: ${name} ${entry.size} bytes${entry.signed ? ' signed' : ' unsigned'}`)
}
