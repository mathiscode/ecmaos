import { describe, it, expect, beforeAll } from 'vitest'
import binNodeSource from 'virtual:bin-node'

import '@zenfs/linux'
import { Process, execve, DevTmpFS, char_dev, toDev } from '@zenfs/linux'
import { defaultContext, configure, InMemory, fs } from '@zenfs/core'
import { S_IFCHR } from '@zenfs/core/constants'

import { EvdevDevice, installEvdevIoctl } from '#lib/evdev.ts'

/**
 * A worker program's `ioctl` on an event node comes back with the length of what the device answered (the bytes themselves
 * are left in its return region, as for `TCGETS`). Same setup as `fd-syscalls.test.ts`.
 */
describe('evdev ioctl from a worker program', () => {
  beforeAll(async () => {
    const devtmpfs = new DevTmpFS()
    await configure({ mounts: { '/': InMemory, '/dev': devtmpfs } })
    await fs.promises.writeFile('/dev/console', '')
    await fs.promises.mkdir('/bin')
    await fs.promises.writeFile('/bin/node', binNodeSource, { mode: 0o755 })
    const [keyboard] = await EvdevDevice.getDrivers({} as never)
    char_dev.register(13, 'input', keyboard!.ops)
    devtmpfs.mknodSync('/event0', S_IFCHR | 0o666, toDev({ major: 13, minor: 64 }))
    installEvdevIoctl()
  })

  it('gets the length of the version, the name and the key bits', async () => {
    await fs.promises.writeFile('/p.js', `
      const { open, write, close, ioctl, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls
      const fd = open('/dev/event0', O_RDONLY, 0)
      const out = [ioctl(fd, ((2 << 30) | (4 << 16) | (0x45 << 8) | 0x01) >>> 0, undefined), ioctl(fd, ((2 << 30) | (64 << 16) | (0x45 << 8) | 0x06) >>> 0, undefined), ioctl(fd, ((2 << 30) | (96 << 16) | (0x45 << 8) | 0x21) >>> 0, undefined)]
      close(fd)
      const r = open('/result', O_WRONLY | O_CREAT | O_TRUNC, 0o644); write(r, new TextEncoder().encode(out.join(','))); close(r)
    `, { mode: 0o755 })
    const proc = new Process({ context: defaultContext })
    await execve(proc, '/p.js', ['/p.js'], {})
    expect(await proc.exited).toBe(0)
    expect(await fs.promises.readFile('/result', 'utf-8')).toBe('4,16,96')
  })
})
