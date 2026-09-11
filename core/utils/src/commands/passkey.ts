import chalk from 'chalk'
import type { Kernel, Shell, Terminal } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

function printUsage(io: CommandIO): void {
  const usage = `Usage: passkey <subcommand> [options]

Subcommands:
  register [--name <name>]    Register a new passkey
  list                        List all registered passkeys
  remove --id <id>            Remove a specific passkey
  remove-all                  Remove all passkeys

  --help  display this help and exit`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'passkey',
    description: 'Manage passkey credentials for WebAuthn authentication',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {
      const process = ctx.process

      if (!process) return 1

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      const currentUid = shell.credentials.uid
      const user = kernel.users.get(currentUid)
      if (!user) {
        await io.writelnErr(chalk.red('Error: Current user not found'))
        return 1
      }

      if (ctx.argv.length === 0) {
        printUsage(io)
        return 0
      }

      const subcommand = ctx.argv[0]?.toLowerCase()
      let name: string | undefined
      let id: string | undefined

      for (let i = 1; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (!arg) continue

        if (arg === '--name' && i + 1 < ctx.argv.length) {
          name = ctx.argv[++i]
        } else if (arg.startsWith('--name=')) {
          name = arg.slice(7)
        } else if (arg === '--id' && i + 1 < ctx.argv.length) {
          id = ctx.argv[++i]
        } else if (arg.startsWith('--id=')) {
          id = arg.slice(5)
        }
      }

      if (!subcommand || subcommand === 'help') {
        printUsage(io)
        return 0
      }

      try {
        switch (subcommand) {
          case 'register': {
            if (!kernel.auth.passkey.isSupported()) {
              await io.writelnErr(chalk.red('Error: WebAuthn is not supported in this browser'))
              return 1
            }

            const username = user.username
            const userId = new TextEncoder().encode(username)

            const challenge = crypto.getRandomValues(new Uint8Array(32))
            const rpId = globalThis.location.hostname || 'localhost'

            const createOptions: PublicKeyCredentialCreationOptions = {
              challenge,
              rp: {
                name: kernel.name || 'ecmaOS',
                id: rpId
              },
              user: {
                id: userId,
                name: username,
                displayName: username
              },
              pubKeyCredParams: [
                { type: 'public-key', alg: -7 },
                { type: 'public-key', alg: -257 }
              ],
              authenticatorSelection: {
                userVerification: 'preferred'
              },
              timeout: 60000
            }

            await io.writeln(chalk.yellow('Please interact with your authenticator to register a passkey...'))
            const credential = await kernel.auth.passkey.create(createOptions)

            if (!credential || !(credential instanceof PublicKeyCredential)) {
              await io.writelnErr(chalk.red('Error: Failed to create passkey. Registration cancelled or failed.'))
              return 1
            }

            const publicKeyCredential = credential as PublicKeyCredential
            const response = publicKeyCredential.response as AuthenticatorAttestationResponse

            const credentialId = btoa(String.fromCharCode(...new Uint8Array(publicKeyCredential.rawId)))
            
            let publicKeyArray: Uint8Array
            
            try {
              if (typeof response.getPublicKey === 'function') {
                try {
                  const publicKeyCrypto = response.getPublicKey()
                  
                  if (publicKeyCrypto && publicKeyCrypto instanceof CryptoKey) {
                    const publicKeyJwk = await crypto.subtle.exportKey('jwk', publicKeyCrypto)
                    publicKeyArray = new TextEncoder().encode(JSON.stringify(publicKeyJwk))
                  } else {
                    throw new Error('getPublicKey() did not return a valid CryptoKey')
                  }
                } catch (exportError) {
                  await io.writelnErr(chalk.yellow(`Warning: Could not extract public key via getPublicKey(): ${exportError instanceof Error ? exportError.message : String(exportError)}. Using attestationObject instead.`))
                  const attestationObject = response.attestationObject
                  publicKeyArray = new Uint8Array(attestationObject)
                }
              } else {
                const attestationObject = response.attestationObject
                publicKeyArray = new Uint8Array(attestationObject)
              }
            } catch (error) {
              await io.writelnErr(chalk.red(`Error processing credential data: ${error instanceof Error ? error.message : String(error)}`))
              return 1
            }

            const passkey = {
              id: crypto.randomUUID(),
              credentialId,
              publicKey: publicKeyArray,
              createdAt: Date.now(),
              name
            }

            await kernel.users.addPasskey(currentUid, passkey)
            await io.writeln(chalk.green(`Passkey registered successfully${name ? `: ${name}` : ''}`))
            await io.writeln(`Passkey ID: ${passkey.id}`)
            return 0
          }

          case 'list': {
            const passkeys = await kernel.users.getPasskeys(currentUid)
            
            if (passkeys.length === 0) {
              await io.writeln('No passkeys registered for this user.')
              return 0
            }

            await io.writeln(`Registered passkeys (${passkeys.length}):`)
            await io.writeln('')
            
            for (const pk of passkeys) {
              const createdDate = new Date(pk.createdAt).toLocaleString()
              const lastUsedDate = pk.lastUsed ? new Date(pk.lastUsed).toLocaleString() : 'Never'
              await io.writeln(`  ID: ${pk.id}`)
              if (pk.name) {
                await io.writeln(`    Name: ${pk.name}`)
              }
              await io.writeln(`    Created: ${createdDate}`)
              await io.writeln(`    Last used: ${lastUsedDate}`)
              await io.writeln('')
            }
            return 0
          }

          case 'remove': {
            if (!id) {
              await io.writelnErr(chalk.red('Error: --id is required for remove command'))
              await io.writelnErr('Usage: passkey remove --id <id>')
              return 1
            }

            const passkeys = await kernel.users.getPasskeys(currentUid)
            const passkey = passkeys.find(pk => pk.id === id)
            
            if (!passkey) {
              await io.writelnErr(chalk.red(`Error: Passkey with ID ${id} not found`))
              return 1
            }

            await kernel.users.removePasskey(currentUid, id)
            await io.writeln(chalk.green(`Passkey removed successfully${passkey.name ? `: ${passkey.name}` : ''}`))
            return 0
          }

          case 'remove-all': {
            const passkeys = await kernel.users.getPasskeys(currentUid)
            
            if (passkeys.length === 0) {
              await io.writeln('No passkeys to remove.')
              return 0
            }

            await kernel.users.savePasskeys(currentUid, [])
            const passkeysPath = `${user.home}/.passkeys`
            try {
              await kernel.filesystem.fs.unlink(passkeysPath)
            } catch {}

            await io.writeln(chalk.green(`Removed ${passkeys.length} passkey(s)`))
            return 0
          }

          default:
            await io.writelnErr(chalk.red(`Error: Unknown subcommand: ${subcommand}`))
            await io.writelnErr('Run "passkey help" for usage information')
            return 1
        }
      } catch (error) {
        await io.writelnErr(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`))
        return 1
      }
    }
  })
}
