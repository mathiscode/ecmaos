/**
 * Makes the key that signs the in-tree modules: `node scripts/module-key.mjs [DIR]` writes `ecmaos.key` (private, mode 600)
 * and `ecmaos.pub` (public) in DIR (default: the current directory). Keep the private key out of the repository: build with
 * `ECMAOS_MODULE_KEY=/path/to/ecmaos.key`, and put the public key in `ECMAOS_MODULE_PUBKEY` when you build the kernel, so
 * `/etc/modules-keys/ecmaos.pub` trusts it.
 */

import { createHash, webcrypto } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? '.')
const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey)
const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey))
const id = createHash('sha256').update(pub).digest().subarray(0, 8).toString('hex')

writeFileSync(path.join(dir, 'ecmaos.key'), JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }) + '\n', { mode: 0o600 })
chmodSync(path.join(dir, 'ecmaos.key'), 0o600)
writeFileSync(path.join(dir, 'ecmaos.pub'), `# ecmaos module key ecmaos (${id})\n${pub.toString('base64')}\n`)
console.log(`wrote ${path.join(dir, 'ecmaos.key')} (keep it secret) and ${path.join(dir, 'ecmaos.pub')}`)
console.log(`key id ${id}`)
console.log(`ECMAOS_MODULE_PUBKEY=${pub.toString('base64')}`)
