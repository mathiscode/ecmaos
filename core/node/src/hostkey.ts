import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { generateKeyPair, publicKeyOf } from '@ecmaos/peer'
import type { KeyPair } from '@ecmaos/peer'

/**
 * This machine's identity on the network: an ECDSA P-384 key pair kept in the data folder (mode 0600). A client pins its
 * fingerprint the first time it connects, and refuses the machine if the key ever changes. Without a data folder (an
 * ephemeral machine) the key lives only as long as the process, and the fingerprint changes with every start.
 */
export async function loadHostKey(dataDir: string | undefined): Promise<KeyPair> {
  if (!dataDir) return await generateKeyPair()
  const file = path.join(dataDir, 'ecmaosd', 'host_key.json')
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { publicKey?: unknown, privateKey?: JsonWebKey }
    const publicKey = publicKeyOf(stored.publicKey)
    if (!publicKey || !stored.privateKey) throw new Error(`${file} is not a host key`)
    return { publicKey, privateKey: stored.privateKey }
  }
  const pair = await generateKeyPair()
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(pair) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return pair
}
