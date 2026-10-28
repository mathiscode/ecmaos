import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * gpg in the kernel: making a key, signing and verifying, encrypting and decrypting, with a passphrase given on the
 * command line since there is no terminal to ask on. GnuPG interoperability is checked outside, against GnuPG itself.
 */
describe('gpg', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const read = (path: string) => fs().readFile(path, 'utf-8').catch(() => '')
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/out 2> /tmp/err`)
    return { code, out: await read('/tmp/out'), err: await read('/tmp/err') }
  }
  const gpg = (args: string) => run(`gpg --batch --passphrase secret ${args}`)

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
  }, 60_000)

  it('makes a key and lists it', async () => {
    const made = await gpg('--quick-gen-key "Test User <test@example.com>"')
    expect(made.code).toBe(0)
    expect(made.err).toContain('public and secret key created and signed.')
    expect(((await fs().stat('/root/.gnupg')).mode & 0o777)).toBe(0o700)
    const list = await run('gpg -k')
    expect(list.out).toMatch(/pub {3}ed25519 \d{4}-\d\d-\d\d \[SC\] \[expires: /)
    expect(list.out).toContain('uid           [ultimate] Test User <test@example.com>')
    expect(list.out).toMatch(/sub {3}cv25519 .* \[E\]/)
    expect((await run('gpg -K')).out).toMatch(/^sec {3}ed25519/m)
  }, 60_000)

  it('signs and verifies, and finds a changed file', async () => {
    await fs().writeFile('/tmp/doc.txt', 'the document\n')
    expect((await gpg('--detach-sign /tmp/doc.txt')).code).toBe(0)
    const good = await run('gpg --verify /tmp/doc.txt.sig /tmp/doc.txt')
    expect(good.code).toBe(0)
    expect(good.err).toContain('Good signature from "Test User <test@example.com>" [ultimate]')
    await fs().writeFile('/tmp/doc.txt', 'the document, changed\n')
    const bad = await run('gpg --verify /tmp/doc.txt.sig /tmp/doc.txt')
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('BAD signature')
    expect((await gpg('--clearsign -o /tmp/doc.asc /tmp/doc.txt')).code).toBe(0)
    expect(await read('/tmp/doc.asc')).toMatch(/^-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nthe document, changed\n\n-----BEGIN PGP SIGNATURE-----/)
    expect((await run('gpg --verify /tmp/doc.asc')).code).toBe(0)
  }, 60_000)

  it('encrypts to the key and decrypts, and with a passphrase alone', async () => {
    await fs().writeFile('/tmp/plain.txt', 'meet at noon\n')
    expect((await gpg('-a -r test@example.com -e -o /tmp/plain.asc /tmp/plain.txt')).code).toBe(0)
    expect(await read('/tmp/plain.asc')).toMatch(/^-----BEGIN PGP MESSAGE-----/)
    const back = await gpg('-d /tmp/plain.asc')
    expect(back.out).toBe('meet at noon\n')
    expect(back.err).toMatch(/encrypted with cv25519 key, ID [0-9A-F]{16}/)
    expect((await run('gpg --batch --passphrase wrong -d /tmp/plain.asc')).code).toBe(2)
    expect((await run('gpg --batch --passphrase pass -c -o /tmp/sym.gpg /tmp/plain.txt')).code).toBe(0)
    expect((await run('gpg --batch --passphrase pass -d /tmp/sym.gpg')).out).toBe('meet at noon\n')
  }, 60_000)

  it('exports and imports keys, and deletes them', async () => {
    expect((await run('gpg -a --export -o /tmp/pub.asc test@example.com')).code).toBe(0)
    expect(await read('/tmp/pub.asc')).toMatch(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/)
    const imported = await run('gpg --homedir /tmp/other --import /tmp/pub.asc')
    expect(imported.err).toMatch(/public key "Test User <test@example.com>" imported/)
    expect((await run('gpg --homedir /tmp/other -k')).out).toContain('[ unknown] Test User')
    // encrypting to a key of unknown validity asks, and in batch mode does not use it
    expect((await run('gpg --homedir /tmp/other --batch -r test@example.com -e /tmp/plain.txt')).code).toBe(2)
    expect((await run('gpg --homedir /tmp/other --batch --trust-model always -r test@example.com -o /tmp/other.gpg -e /tmp/plain.txt')).code).toBe(0)
    expect((await gpg('-d /tmp/other.gpg')).out).toBe('meet at noon\n')
    expect((await run('gpg --homedir /tmp/other --batch --yes --delete-keys test@example.com')).code).toBe(0)
    expect((await run('gpg --homedir /tmp/other -k')).out).toBe('')
    expect((await run('gpg --batch --yes --delete-keys test@example.com')).err).toContain('there is a secret key for public key')
  }, 60_000)
})
