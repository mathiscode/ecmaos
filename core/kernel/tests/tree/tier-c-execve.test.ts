import { beforeAll, describe, expect, it, vi } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * `mount`, `passkey` and `screensaver-daemon`: real worker-hosted programs whose work needs the main
 * thread (`fs_mount`, `auth_passkey`, `screensaver_start`). The programs parse arguments and print;
 * these tests drive them through the shell and assert on output plus the kernel state they change.
 */
describe('mount, passkey and screensaver-daemon as execve programs', () => {
  let kernel: Kernel
  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/tc.out 2> /tmp/tc.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/tc.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/tc.err', 'utf8')
    }
  }

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  describe('mount', () => {
    it('is a real file under /bin, not a legacy in-process command', async () => {
      expect(await kernel.filesystem.fs.exists('/bin/mount')).toBe(true)
      expect(await kernel.filesystem.fs.exists('/bin/passkey')).toBe(true)
      expect(await kernel.filesystem.fs.exists('/bin/screensaver-daemon')).toBe(true)
    })

    it('mounts a memory filesystem, creating the target, and it is usable and listed', async () => {
      const { code, out } = await run('mount -t memory /mnt/tc-mem')
      expect(code).toBe(0)
      expect(out).toContain('Mounted memory filesystem at /mnt/tc-mem')
      expect(kernel.filesystem.mounts.has('/mnt/tc-mem')).toBe(true)

      await kernel.filesystem.fs.writeFile('/mnt/tc-mem/hello.txt', 'hi')
      expect(await kernel.filesystem.fs.readFile('/mnt/tc-mem/hello.txt', 'utf8')).toBe('hi')

      const listed = await run('mount -l')
      expect(listed.out).toMatch(/\/mnt\/tc-mem\s+\S+/)
      expect((await run('mount')).out).toBe(listed.out)
    })

    it('resolves a relative target against the shell cwd', async () => {
      await kernel.shell.execute('cd /tmp')
      const { code, out } = await run('mount -t memory relmount')
      await kernel.shell.execute('cd /')
      expect(code).toBe(0)
      expect(out).toContain('/tmp/relmount')
      expect(kernel.filesystem.mounts.has('/tmp/relmount')).toBe(true)
    })

    it('mounts a singlebuffer with a size option and rejects a bad size', async () => {
      const sb = await run('mount -t singlebuffer /mnt/tc-buf -o size=65536'); expect(sb.code).toBe(0)
      const bad = await run('mount -t singlebuffer /mnt/tc-buf2 -o size=abc')
      expect(bad.code).toBe(1)
      expect(bad.err).toContain('mount: invalid buffer size for singlebuffer type')
    })

    it('mounts a zip from a local file and reads it back', async () => {
      const { zipSync, strToU8 } = await import('fflate')
      await kernel.filesystem.fs.writeFile('/tmp/tc.zip', zipSync({ 'a.txt': strToU8('from zip') }))

      const { code, out } = await run('mount -t zip /tmp/tc.zip /mnt/tc-zip')
      expect(code).toBe(0)
      expect(out).toContain('Reading archive from /tmp/tc.zip...')
      expect(out).toContain('Mounted zip filesystem from /tmp/tc.zip to /mnt/tc-zip')
      expect(await kernel.filesystem.fs.readFile('/mnt/tc-zip/a.txt', 'utf8')).toBe('from zip')
    })

    it('reports a missing archive', async () => {
      const { code, err } = await run('mount -t zip /tmp/nope.zip /mnt/tc-nozip')
      expect(code).toBe(1)
      expect(err).toContain('mount: archive file not found: /tmp/nope.zip')
    })

    it('validates arguments before touching the kernel', async () => {
      expect((await run('mount /mnt/x')).err).toContain('mount: filesystem type must be specified')
      expect((await run('mount -t memory')).err).toContain('mount: missing target argument')
      expect((await run('mount -t memory a b c')).err).toContain('mount: too many arguments')
      expect((await run('mount -t memory src /mnt/x')).err).toContain('memory filesystem does not require a source')
      expect((await run('mount -t zip /mnt/x')).err).toContain('zip filesystem requires a source file or URL')
      expect((await run('mount -t')).err).toContain("option requires an argument -- 't'")
      expect((await run('mount -t bogus /mnt/x')).err).toContain("mount: unknown filesystem type 'bogus'")
      expect((await run('mount --help')).err).toContain('Usage: mount')
    })

    it('fails with a clear error when a picker or OPFS backend is unavailable', async () => {
      expect((await run('mount -t opfs /mnt/tc-opfs')).err).toMatch(/Origin Private File System is not available/)
      expect((await run('mount -t webaccess /mnt/tc-wa')).err).toMatch(/File System Access API is not available/)
    })

    it('rejects an unknown webstorage type', async () => {
      expect((await run('mount -t webstorage /mnt/tc-ws2 -o storage=nope')).err).toContain("invalid storage type 'nope'")
    })

    it('reports the Google Drive failure with guidance instead of hanging (scripts cannot load offline)', async () => {
      const original = document.head.appendChild.bind(document.head)
      vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
        if (node instanceof HTMLScriptElement) { queueMicrotask(() => node.onerror?.(new Event('error'))); return node }
        return original(node)
      }) as never)

      const { code, out, err } = await run('mount -t googledrive /mnt/tc-gd -o apiKey=k')
      vi.restoreAllMocks()
      expect(code).toBe(1)
      expect(out).toContain('Loading Google Identity Services library...')
      expect(err).toContain('mount: failed to mount googledrive filesystem: Failed to load Google Identity Services script')
    })

    it('processes /etc/fstab with -a: mounts what it can, skips interactive backends, and summarises', async () => {
      await kernel.filesystem.fs.writeFile('/etc/fstab', [
        '# comment',
        'none /mnt/tc-fstab-mem memory',
        'none /mnt/tc-fstab-wa webaccess',
        'none /mnt/tc-fstab-zip zip',
        ''
      ].join('\n'))

      const { code, out, err } = await run('mount -a')
      expect(code).toBe(1)
      expect(kernel.filesystem.mounts.has('/mnt/tc-fstab-mem')).toBe(true)
      expect(out).toContain('Mounting 3 filesystem(s) from /etc/fstab...')
      expect(err).toContain('skipping /mnt/tc-fstab-wa: webaccess requires interactive directory selection')
      expect(err).toContain('mount: archive file not found: /none')
      expect(out).toContain('Mount summary: 1 succeeded, 2 failed')
    })

    it('kernel.loadFstab still mounts through the program', async () => {
      await kernel.filesystem.fs.writeFile('/etc/fstab', 'none /mnt/tc-loadfstab memory\n')
      await kernel.loadFstab()
      expect(kernel.filesystem.mounts.has('/mnt/tc-loadfstab')).toBe(true)
    })

    it('umount round-trips what mount created', async () => {
      const { code } = await run('umount /mnt/tc-mem')
      expect(code).toBe(0)
      expect(kernel.filesystem.mounts.has('/mnt/tc-mem')).toBe(false)
    })
  })

  describe('passkey', () => {
    it('prints usage with no arguments and on help', async () => {
      expect((await run('passkey')).err).toContain('Usage: passkey <subcommand>')
      expect((await run('passkey help')).err).toContain('Usage: passkey <subcommand>')
      expect((await run('passkey --help')).code).toBe(0)
    })

    it('rejects an unknown subcommand', async () => {
      const { code, err } = await run('passkey frobnicate')
      expect(code).toBe(1)
      expect(err).toContain('Error: Unknown subcommand: frobnicate')
    })

    it('lists none, then registers (stubbed authenticator), lists, removes and removes-all', async () => {
      expect((await run('passkey list')).out).toContain('No passkeys registered for this user.')

      const user = kernel.users.get(0)!
      await kernel.users.addPasskey(0, { id: 'pk-1', credentialId: 'cred-1', publicKey: new Uint8Array([1, 2]), createdAt: 1_700_000_000_000, name: 'laptop' })
      await kernel.users.addPasskey(0, { id: 'pk-2', credentialId: 'cred-2', publicKey: new Uint8Array([3]), createdAt: 1_700_000_100_000 })

      const listed = await run('passkey list')
      expect(listed.out).toContain('Registered passkeys (2):')
      expect(listed.out).toContain('ID: pk-1')
      expect(listed.out).toContain('Name: laptop')
      expect(listed.out).toContain('Last used: Never')

      expect((await run('passkey remove')).err).toContain('--id is required for remove command')
      expect((await run('passkey remove --id nope')).err).toContain('Error: Passkey with ID nope not found')

      const removed = await run('passkey remove --id=pk-1')
      expect(removed.out).toContain('Passkey removed successfully: laptop')
      expect((await kernel.users.getPasskeys(0)).map(pk => pk.id)).toEqual(['pk-2'])

      expect((await run('passkey remove-all')).out).toContain('Removed 1 passkey(s)')
      expect(await kernel.users.getPasskeys(0)).toEqual([])
      expect((await run('passkey remove-all')).out).toContain('No passkeys to remove.')
      expect(user.username).toBe('root')
    })

    it('register reports when WebAuthn is not supported', async () => {
      vi.spyOn(kernel.auth.passkey, 'isSupported').mockReturnValue(false)
      const { code, err } = await run('passkey register --name x')
      vi.restoreAllMocks()
      expect(code).toBe(1)
      expect(err).toContain('Error: WebAuthn is not supported in this browser')
    })

    it('register reports a cancelled ceremony, and never stores a passkey', async () => {
      vi.spyOn(kernel.auth.passkey, 'isSupported').mockReturnValue(true)
      vi.spyOn(kernel.auth.passkey, 'create').mockResolvedValue(null)
      const { code, out, err } = await run('passkey register')
      vi.restoreAllMocks()
      expect(code).toBe(1)
      expect(out).toContain('Please interact with your authenticator')
      expect(err).toContain('Failed to create passkey')
      expect(await kernel.users.getPasskeys(0)).toEqual([])
    })

    it('register stores the credential the authenticator returns', async () => {
      class FakeCredential {
        rawId = new Uint8Array([9, 8, 7]).buffer
        response = { attestationObject: new Uint8Array([5, 5, 5]).buffer }
      }
      vi.stubGlobal('PublicKeyCredential', FakeCredential)
      vi.spyOn(kernel.auth.passkey, 'isSupported').mockReturnValue(true)
      vi.spyOn(kernel.auth.passkey, 'create').mockResolvedValue(new FakeCredential() as unknown as Credential)

      const { code, out } = await run('passkey register --name=phone')
      vi.restoreAllMocks()
      vi.unstubAllGlobals()

      expect(code).toBe(0)
      expect(out).toContain('Passkey registered successfully: phone')
      const stored = await kernel.users.getPasskeys(0)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ credentialId: btoa(String.fromCharCode(9, 8, 7)), name: 'phone' })
      expect(out).toContain(`Passkey ID: ${stored[0]!.id}`)
      await kernel.users.savePasskeys(0, [])
    })
  })

  describe('screensaver-daemon', () => {
    it('starts the daemon quietly and reports an unknown configured screensaver', async () => {
      const stop = vi.fn()
      const start = vi.spyOn(kernel, 'startScreensaverDaemon').mockReturnValue(stop)
      const started = await run('screensaver-daemon')
      expect(started).toMatchObject({ code: 0, out: '', err: '' })
      expect(start).toHaveBeenCalledTimes(1)

      start.mockReturnValue(undefined)
      const missing = await run('screensaver-daemon')
      vi.restoreAllMocks()
      expect(missing.code).toBe(1)
      expect(missing.err).toContain('screensaver-daemon: no such screensaver configured')
    })

    it('prints usage for --help without starting anything', async () => {
      const start = vi.spyOn(kernel, 'startScreensaverDaemon')
      const { code, err } = await run('screensaver-daemon --help')
      expect(code).toBe(0)
      expect(err).toContain('Usage: screensaver-daemon')
      expect(start).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })
  })
})
