import { ioctl } from '@zenfs/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { inputHub, KeyboardMinor } from '#lib/evdev.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('/dev/input/event*', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  it('are character devices on major 13, and hid has left that major', async () => {
    const fs = kernel.filesystem.fs
    const stat = await fs.stat('/dev/input/event0')
    expect(stat.isCharacterDevice()).toBe(true)
    expect(Number(BigInt(stat.rdev) >> 20n)).toBe(13)
    expect(Number(BigInt(stat.rdev) & 0xfffffn)).toBe(64)
    expect(Number(BigInt((await fs.stat('/dev/input/event1')).rdev) & 0xfffffn)).toBe(65)
    expect(Number(BigInt((await fs.stat('/dev/hid')).rdev) >> 20n)).not.toBe(13)
  })

  it('a program reading event0 gets the events typed after it opened it', async () => {
    const reading = kernel.shell.execute('head -c 48 /dev/input/event0 | od -An -tu1 -w24 > /tmp/event0.out')
    for (let i = 0; i < 100 && !inputHub.listening(KeyboardMinor); i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(inputHub.listening(KeyboardMinor)).toBe(true)
    inputHub.keyboard('KeyA', 1)
    await reading
    const lines = (await kernel.filesystem.fs.readFile('/tmp/event0.out', 'utf-8')).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    expect(lines).toHaveLength(2)
    // type (bytes 16-17), code (18-19), value (20-23) of the key event
    expect(lines[0]!.slice(16, 24)).toEqual([1, 0, 30, 0, 1, 0, 0, 0])
    expect(lines[1]!.slice(16, 18)).toEqual([0, 0])
  })

  it('answers EVIOCGVERSION and EVIOCGNAME through the file system', async () => {
    const version = await ioctl('/dev/input/event0', (2 << 30) | (4 << 16) | (0x45 << 8) | 0x01) as Uint8Array
    expect(new DataView(version.buffer, version.byteOffset).getInt32(0, true)).toBe(0x010001)
    const name = await ioctl('/dev/input/event1', (2 << 30) | (64 << 16) | (0x45 << 8) | 0x06) as Uint8Array
    expect(new TextDecoder().decode(name).replace(/\0.*$/, '')).toBe('ecmaOS pointer')
  })
})
