import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * fmt/crypto/curl/fetch migrated onto real execve. fmt is pure text reformatting over real file
 * reads. crypto/curl/fetch use only standard Worker globals (crypto.subtle/crypto.getRandomValues,
 * fetch) plus real fs syscalls -- chalk (ANSI coloring) is dropped from all three, matching
 * ls.mjs's precedent.
 */
describe('text command batch 14: fmt/crypto/curl/fetch, real execve', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()

    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  for (const name of ['fmt', 'crypto', 'curl', 'fetch']) {
    it(`${name} is a real execve file, not the legacy stub`, async () => {
      const content = await kernel.filesystem.fs.readFile(`/bin/${name}`, 'utf-8')
      expect(content.startsWith('#!ecmaos:bin:command:')).toBe(false)
    })
  }

  it('fmt joins short lines up to the default width', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/fmt-in.txt', 'one\ntwo\nthree\n')
    const code = await kernel.shell.execute('fmt /tmp/fmt-in.txt > /tmp/fmt-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/fmt-out.txt', 'utf-8')
    expect(out.trim()).toBe('one two three')
  })

  it('fmt -w wraps at a custom width', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/fmt-width-in.txt', 'aaaa bbbb cccc dddd\n')
    const code = await kernel.shell.execute('fmt -w 10 /tmp/fmt-width-in.txt > /tmp/fmt-width-out.txt')
    expect(code).toBe(0)
    const out = await kernel.filesystem.fs.readFile('/tmp/fmt-width-out.txt', 'utf-8')
    const lines = out.trim().split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10)
  })

  it('crypto random generates the requested number of bytes', async () => {
    const code = await kernel.shell.execute('crypto random --length 16 --output /tmp/crypto-random.bin')
    expect(code).toBe(0)
    const stat = await kernel.filesystem.fs.stat('/tmp/crypto-random.bin')
    expect(stat.size).toBe(16)
  })

  it('crypto generate + encrypt + decrypt round-trips real AES-GCM ciphertext', async () => {
    let code = await kernel.shell.execute('crypto generate --algorithm aes-gcm --length 256 --output /tmp/crypto-key.json')
    expect(code).toBe(0)

    await kernel.filesystem.fs.writeFile('/tmp/crypto-plain.txt', 'super secret data')
    code = await kernel.shell.execute('crypto encrypt --algorithm aes-gcm --key-file /tmp/crypto-key.json --input /tmp/crypto-plain.txt --output /tmp/crypto-enc.bin')
    expect(code).toBe(0)

    code = await kernel.shell.execute('crypto decrypt --algorithm aes-gcm --key-file /tmp/crypto-key.json --input /tmp/crypto-enc.bin --output /tmp/crypto-dec.txt')
    expect(code).toBe(0)

    const decrypted = await kernel.filesystem.fs.readFile('/tmp/crypto-dec.txt', 'utf-8')
    expect(decrypted).toBe('super secret data')
  })

  it('crypto sign + verify round-trips a real HMAC signature', async () => {
    let code = await kernel.shell.execute('crypto generate --algorithm hmac --hash SHA-256 --output /tmp/crypto-hmac-key.json')
    expect(code).toBe(0)

    await kernel.filesystem.fs.writeFile('/tmp/crypto-sign-in.txt', 'message to sign')
    code = await kernel.shell.execute('crypto sign --algorithm hmac --key-file /tmp/crypto-hmac-key.json --input /tmp/crypto-sign-in.txt --output /tmp/crypto-sig.bin')
    expect(code).toBe(0)

    code = await kernel.shell.execute('crypto verify --algorithm hmac --key-file /tmp/crypto-hmac-key.json --input /tmp/crypto-sign-in.txt --signature /tmp/crypto-sig.bin')
    expect(code).toBe(0)
  })

  it('crypto errors on an unknown subcommand', async () => {
    const code = await kernel.shell.execute('crypto bogus-subcommand 2>/tmp/crypto-bogus.err')
    expect(code).toBe(1)
  })

  it('curl fetches a resource and writes it to a file', async () => {
    const code = await kernel.shell.execute('curl -o /tmp/curl-out.txt https://example.com')
    expect(code).toBe(0)
    const stat = await kernel.filesystem.fs.stat('/tmp/curl-out.txt')
    expect(stat.size).toBeGreaterThan(0)
  })

  it('fetch fetches a resource and writes it to stdout', async () => {
    const code = await kernel.shell.execute('fetch https://example.com > /tmp/fetch-out.txt')
    expect(code).toBe(0)
    const stat = await kernel.filesystem.fs.stat('/tmp/fetch-out.txt')
    expect(stat.size).toBeGreaterThan(0)
  })

  it('fetch errors when no URL is given', async () => {
    const code = await kernel.shell.execute('fetch 2>/tmp/fetch-nourl.err')
    expect(code).toBe(1)
  })
})
