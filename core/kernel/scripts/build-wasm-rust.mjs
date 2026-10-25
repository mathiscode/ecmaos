/**
 * Builds a kernel module written in Rust for WASI 0.3: `node scripts/build-wasm-rust.mjs CRATE-DIR OUT.ko.wasm`. The crate
 * has `module.json` (the modinfo) and a `rust-toolchain.toml` that selects the nightly compiler (stable has no
 * `wasm32-wasip3` standard library yet), so the toolchain you use elsewhere is not changed. The compiler links a component
 * itself; this packs it with the modinfo, and checks it with wasm-tools if that is installed (ECMAOS_WASM_TOOLS is the
 * directory it is in, else PATH). With ECMAOS_MODULE_KEY set to a private key file (`module-key.mjs` makes one) the result is signed.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { signWasm } from './module-sign.mjs'
import { packWasmModule } from './wasm-module.mjs'

const [crate, out] = process.argv.slice(2)
if (!crate || !out) {
  console.error('usage: build-wasm-rust.mjs CRATE-DIR OUT.ko.wasm')
  process.exit(2)
}

const dir = path.resolve(crate)
const tools = process.env.ECMAOS_WASM_TOOLS ? [path.join(process.env.ECMAOS_WASM_TOOLS, 'bin'), process.env.ECMAOS_WASM_TOOLS] : []
const env = { ...process.env, PATH: [...tools, process.env.PATH].join(path.delimiter) }
const name = JSON.parse(readFileSync(path.join(dir, 'module.json'), 'utf8')).name

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-wasip3'], { cwd: dir, env, stdio: 'inherit' })
const built = path.join(dir, 'target/wasm32-wasip3/release', `${name}.wasm`)
if (!existsSync(built)) throw new Error(`cargo built no ${built}; the crate's name must be the module's name`)

try {
  execFileSync('wasm-tools', ['validate', '--features', 'all', built], { env, stdio: 'inherit' })
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  console.error('wasm-tools is not installed; the component was not validated')
}

const packed = packWasmModule(readFileSync(built), JSON.parse(readFileSync(path.join(dir, 'module.json'), 'utf8')))
// ECMAOS_MODULE_KEY (a key from module-key.mjs) signs it; ECMAOS_MODULE_SIGNER names the signer
writeFileSync(path.resolve(out), process.env.ECMAOS_MODULE_KEY ? await signWasm(packed, process.env.ECMAOS_MODULE_KEY, process.env.ECMAOS_MODULE_SIGNER) : packed)
console.log(`wrote ${path.resolve(out)} (${path.relative(process.cwd(), fileURLToPath(import.meta.url))})`)
