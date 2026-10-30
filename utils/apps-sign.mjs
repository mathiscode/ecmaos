#!/usr/bin/env node
// Signs what is published under `@ecmaos-apps`, so `install` can check a package against the project's key and not only
// against the registry it came from (a stolen registry token cannot move `latest` or swap a tarball without the key).
//
//   node utils/apps-sign.mjs keygen PRIVATE_KEY_FILE      make an Ed25519 key: the private key goes to the file (PEM,
//                                                         mode 600), the public half is printed as the entry for
//                                                         /etc/ecmaos/trusted-keys.json
//   node utils/apps-sign.mjs sign PRIVATE_KEY_FILE [--registry URL] [--key-id ID]
//                                                         read every @ecmaos-apps package (programs, their -src packages,
//                                                         groups and profiles) from the registry, and write
//                                                         utils/package-index/trust.json and trust.sig.json
//
// Sign after the packages are published and before `@ecmaos/package-index` is; its tarball carries both files, and
// `apt update` brings them to every machine. Publishing, and where the private key lives, are the maintainer's.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { SCOPE, groupsOf, programs } from './apps-packages.mjs'

const OUT = path.resolve(import.meta.dirname, 'package-index')

/** The names of every package the project publishes in its signed scope */
export function publishedNames() {
  const found = programs()
  const { groups, profiles } = groupsOf(found)
  return [
    ...found.flatMap(entry => [entry.package, ...(entry.copyleft ? [`${entry.package}-src`] : [])]),
    ...Object.keys(groups).map(name => `${SCOPE}/group-${name}`),
    ...Object.keys(profiles).map(name => `${SCOPE}/profile-${name}`)
  ].sort()
}

/** `trust.json`'s content for the packuments in `documents` (`{ NAME: packument }`); a package the registry lacks is left out */
export function trustOf(documents) {
  const packages = {}
  for (const [name, document] of Object.entries(documents)) {
    if (!document?.versions) continue
    const versions = Object.fromEntries(Object.entries(document.versions).map(([version, manifest]) => [version, manifest.dist?.integrity]).filter(([, integrity]) => integrity).sort(([a], [b]) => a.localeCompare(b)))
    if (document['dist-tags']?.latest && versions[document['dist-tags'].latest]) packages[name] = { latest: document['dist-tags'].latest, versions }
  }
  return { schema: 1, packages }
}

const rawPublic = key => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
const keyIdOf = key => `ed25519:${createHash('sha256').update(rawPublic(key)).digest('hex').slice(0, 16)}`

export function keygen(file) {
  const { privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  chmodSync(file, 0o600)
  return { keyId: keyIdOf(privateKey), key: rawPublic(privateKey).toString('base64') }
}

/** The text of `trust.json` and the `trust.sig.json` that goes with it */
export function signTrust(trust, keyFile, keyId) {
  const privateKey = createPrivateKey(readFileSync(keyFile))
  const text = JSON.stringify(trust, null, 2) + '\n'
  return { text, signature: { keyId: keyId ?? keyIdOf(privateKey), signature: sign(null, Buffer.from(text), privateKey).toString('base64') } }
}

async function main() {
  const [command, file, ...rest] = process.argv.slice(2)
  if (command === 'keygen' && file) {
    console.log(JSON.stringify(keygen(file), null, 2))
  } else if (command === 'sign' && file) {
    const option = name => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1] }
    const registry = (option('--registry') ?? process.env.REGISTRY ?? 'http://127.0.0.1:4893').replace(/\/+$/, '')
    const documents = {}
    for (const name of publishedNames()) {
      const response = await fetch(`${registry}/${name}`)
      if (response.ok) documents[name] = await response.json()
    }
    const trust = trustOf(documents)
    const { text, signature } = signTrust(trust, file, option('--key-id'))
    writeFileSync(path.join(OUT, 'trust.json'), text)
    writeFileSync(path.join(OUT, 'trust.sig.json'), JSON.stringify(signature, null, 2) + '\n')
    console.log(`signed ${Object.keys(trust.packages).length} packages from ${registry} with ${signature.keyId}`)
  } else {
    throw new Error('usage: apps-sign.mjs keygen PRIVATE_KEY_FILE | sign PRIVATE_KEY_FILE [--registry URL] [--key-id ID]')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main()
