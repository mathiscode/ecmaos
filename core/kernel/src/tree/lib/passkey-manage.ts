import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

import type { Outcome, OutcomeLine } from './outcome.ts'

/**
 * `passkey`'s work: WebAuthn (`navigator.credentials`) only exists in the page's top-level browsing
 * context, so it cannot run inside the worker that hosts the program. The program parses arguments
 * and reaches this through the `auth_passkey` syscall; this is the original command body, moved.
 * Runs as the *calling* shell's user, same as before.
 */
export async function managePasskey(kernel: Kernel, shell: Shell, subcommand: string, { name, id }: { name?: string, id?: string }): Promise<Outcome> {
  const lines: OutcomeLine[] = []
  const out = (text: string) => lines.push({ stream: 'out', text })
  const err = (text: string) => lines.push({ stream: 'err', text })
  const done = (code: number): Outcome => ({ code, lines })

  const currentUid = shell.credentials.uid
  const user = kernel.users.get(currentUid)
  if (!user) {
    err('Error: Current user not found')
    return done(1)
  }

  try {
    switch (subcommand) {
      case 'register': {
        if (!kernel.auth.passkey.isSupported()) {
          err('Error: WebAuthn is not supported in this browser')
          return done(1)
        }

        const username = user.username
        const createOptions: PublicKeyCredentialCreationOptions = {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: kernel.name || 'ecmaOS', id: globalThis.location.hostname || 'localhost' },
          user: { id: new TextEncoder().encode(username), name: username, displayName: username },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { userVerification: 'preferred' },
          timeout: 60000
        }

        out('Please interact with your authenticator to register a passkey...')
        const credential = await kernel.auth.passkey.create(createOptions)

        if (!credential || !(credential instanceof PublicKeyCredential)) {
          err('Error: Failed to create passkey. Registration cancelled or failed.')
          return done(1)
        }

        const response = credential.response as AuthenticatorAttestationResponse
        const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)))

        let publicKeyArray: Uint8Array
        try {
          if (typeof response.getPublicKey === 'function') {
            try {
              const publicKeyCrypto = response.getPublicKey()
              if (publicKeyCrypto && publicKeyCrypto instanceof CryptoKey) {
                publicKeyArray = new TextEncoder().encode(JSON.stringify(await crypto.subtle.exportKey('jwk', publicKeyCrypto)))
              } else {
                throw new Error('getPublicKey() did not return a valid CryptoKey')
              }
            } catch (exportError) {
              err(`Warning: Could not extract public key via getPublicKey(): ${exportError instanceof Error ? exportError.message : String(exportError)}. Using attestationObject instead.`)
              publicKeyArray = new Uint8Array(response.attestationObject)
            }
          } else {
            publicKeyArray = new Uint8Array(response.attestationObject)
          }
        } catch (error) {
          err(`Error processing credential data: ${error instanceof Error ? error.message : String(error)}`)
          return done(1)
        }

        const passkey = { id: crypto.randomUUID(), credentialId, publicKey: publicKeyArray, createdAt: Date.now(), name }
        await kernel.users.addPasskey(currentUid, passkey)
        out(`Passkey registered successfully${name ? `: ${name}` : ''}`)
        out(`Passkey ID: ${passkey.id}`)
        return done(0)
      }

      case 'list': {
        const passkeys = await kernel.users.getPasskeys(currentUid)
        if (passkeys.length === 0) {
          out('No passkeys registered for this user.')
          return done(0)
        }

        out(`Registered passkeys (${passkeys.length}):`)
        out('')
        for (const pk of passkeys) {
          out(`  ID: ${pk.id}`)
          if (pk.name) out(`    Name: ${pk.name}`)
          out(`    Created: ${new Date(pk.createdAt).toLocaleString()}`)
          out(`    Last used: ${pk.lastUsed ? new Date(pk.lastUsed).toLocaleString() : 'Never'}`)
          out('')
        }
        return done(0)
      }

      case 'remove': {
        if (!id) {
          err('Error: --id is required for remove command')
          err('Usage: passkey remove --id <id>')
          return done(1)
        }

        const passkey = (await kernel.users.getPasskeys(currentUid)).find(pk => pk.id === id)
        if (!passkey) {
          err(`Error: Passkey with ID ${id} not found`)
          return done(1)
        }

        await kernel.users.removePasskey(currentUid, id)
        out(`Passkey removed successfully${passkey.name ? `: ${passkey.name}` : ''}`)
        return done(0)
      }

      case 'remove-all': {
        const passkeys = await kernel.users.getPasskeys(currentUid)
        if (passkeys.length === 0) {
          out('No passkeys to remove.')
          return done(0)
        }

        await kernel.users.savePasskeys(currentUid, [])
        try { await kernel.filesystem.fs.unlink(`${user.home}/.passkeys`) } catch { /* nothing on disk */ }
        out(`Removed ${passkeys.length} passkey(s)`)
        return done(0)
      }

      default:
        err(`Error: Unknown subcommand: ${subcommand}`)
        err('Run "passkey help" for usage information')
        return done(1)
    }
  } catch (error) {
    err(`Error: ${error instanceof Error ? error.message : String(error)}`)
    return done(1)
  }
}
