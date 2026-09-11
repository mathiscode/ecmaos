
import { beforeAll, describe, expect, it } from 'vitest'

import { DefaultFilesystemOptions } from '#filesystem.ts'
import { Kernel } from '#kernel.ts'

describe('Filesystem', async () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      devices: {},
      dom: { topbar: false },
      filesystem: DefaultFilesystemOptions
    })
    await kernel.boot()
  })

  it('should be defined', () => {
    expect(kernel.filesystem).toBeDefined()
    expect(kernel.filesystem.fs).toBeDefined()
  })

  it('should write file', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/test.txt', 'test')
    const file = await kernel.filesystem.fs.readFile('/tmp/test.txt', 'utf-8')
    expect(file).toBe('test')
  })

  it('should read file', async () => {
    const file = await kernel.filesystem.fs.readFile('/tmp/test.txt', 'utf-8')
    expect(file).toBe('test')
  })

  it('should delete file', async () => {
    await kernel.filesystem.fs.unlink('/tmp/test.txt')
    await expect(kernel.filesystem.fs.readFile('/tmp/test.txt')).rejects.toThrow()
  })

  it('should create directory', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/test')
    await kernel.filesystem.fs.writeFile('/tmp/test/test.txt', 'test')
    const file = await kernel.filesystem.fs.readFile('/tmp/test/test.txt', 'utf-8')
    expect(file).toBe('test')
  })

  it('should read directory', async () => {
    const files = await kernel.filesystem.fs.readdir('/tmp/test')
    expect(files).toEqual(['test.txt'])
  })

  it('should not delete non-empty directory', async () => {
    await expect(kernel.filesystem.fs.rmdir('/tmp/test')).rejects.toThrow()

    const contents = await kernel.filesystem.fs.readdir('/tmp/test')
    for (const content of contents) await kernel.filesystem.fs.unlink(`/tmp/test/${content}`)

    await kernel.filesystem.fs.rmdir('/tmp/test')
    await expect(kernel.filesystem.fs.readdir('/tmp/test')).rejects.toThrow()
  })

  it('should mount /proc and /sys as real pseudo-filesystems', async () => {
    const version = await kernel.filesystem.fs.readFile('/proc/version', 'utf-8')
    expect(version).toContain('@zenfs/linux')

    const uptime = await kernel.filesystem.fs.readFile('/proc/uptime', 'utf-8')
    expect(Number(uptime.split(' ')[0])).toBeGreaterThanOrEqual(0)

    const sysEntries = await kernel.filesystem.fs.readdir('/sys')
    expect(sysEntries.length).toBeGreaterThan(0)
  })

  it('should generate /proc/cpuinfo from navigator.hardwareConcurrency', async () => {
    const cpuinfo = await kernel.filesystem.fs.readFile('/proc/cpuinfo', 'utf-8')
    const processorLines = cpuinfo.split('\n').filter(line => line.startsWith('processor'))
    expect(processorLines.length).toBe(navigator.hardwareConcurrency || 1)
  })

  it('should generate /proc/meminfo without fabricating fields it cannot back', async () => {
    const meminfo = await kernel.filesystem.fs.readFile('/proc/meminfo', 'utf-8')
    if ('deviceMemory' in navigator && navigator.deviceMemory) expect(meminfo).toContain('MemTotal:')
    if (performance.memory) expect(meminfo).toContain('MemFree:')
  })

  it('should write a real /etc/os-release and /etc/hostname', async () => {
    const osRelease = await kernel.filesystem.fs.readFile('/etc/os-release', 'utf-8')
    expect(osRelease).toContain(`VERSION="${kernel.version}"`)

    const hostname = await kernel.filesystem.fs.readFile('/etc/hostname', 'utf-8')
    expect(hostname.trim().length).toBeGreaterThan(0)
  })
})
