/**
 * Signs a kernel module the way `sign-module` does, for build scripts: with the private key file `module-key.mjs` writes
 * (ECMAOS_MODULE_KEY), a `NAME.ko.mjs` gets an Ed25519 trailer comment and a `NAME.ko.wasm` a last custom section
 * `ecmaos-module-signature`. Either covers every byte before it. ECMAOS_MODULE_SIGNER names the signer (default `ecmaos`).
 */

import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { customSection } from './wasm-module.mjs'

const fromBase64Url = text => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const hex = bytes => Buffer.from(bytes).toString('hex')

async function signature(body, keyFile) {
  const jwk = JSON.parse(readFileSync(keyFile, 'utf8'))
  const key = await webcrypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign'])
  const sig = Buffer.from(await webcrypto.subtle.sign('Ed25519', key, Buffer.from(body))).toString('base64')
  const id = hex(createHash('sha256').update(fromBase64Url(jwk.x)).digest().subarray(0, 8))
  return { sig, id }
}

/** The trailer comment to append to the text of a JavaScript module */
export async function signatureTrailer(body, keyFile, signer = 'ecmaos') {
  const { sig, id } = await signature(body, keyFile)
  return `/* ecmaos-module-signature\n * signer=${signer}\n * key_id=${id}\n * sig=${sig}\n */\n`
}

/** `bytes` of a WebAssembly module with the signature section appended */
export async function signWasm(bytes, keyFile, signer = 'ecmaos') {
  const { sig, id } = await signature(bytes, keyFile)
  return Buffer.concat([bytes, customSection('ecmaos-module-signature', `signer=${signer}\nkey_id=${id}\nsig=${sig}\n`)])
}
