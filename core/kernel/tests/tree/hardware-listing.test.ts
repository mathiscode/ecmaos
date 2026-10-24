import { beforeAll, describe, expect, it } from 'vitest'
import { GenDisk, block_dev } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** `lsblk` (a command of `@ecmaos/coreutils`), and toybox's `lsusb` and `lspci`, which read `/sys` */
describe('lsblk, lsusb and lspci', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions,
      programs: PROGRAMS_ALL
    })
    await kernel.boot()
  }, 120000)

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/hw.out 2> /tmp/hw.err`)
    return { code, out: await kernel.filesystem.fs.readFile('/tmp/hw.out', 'utf8'), err: await kernel.filesystem.fs.readFile('/tmp/hw.err', 'utf8') }
  }

  it('lsblk prints only its header while no block device is registered', async () => {
    expect(await run('lsblk')).toEqual({ code: 0, out: 'NAME MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS\n', err: '' })
    expect(await run('lsblk -n')).toEqual({ code: 0, out: '', err: '' })
  }, 60000)

  it('lsblk lists a disk and its partitions as a tree, and as a list, in bytes, with columns of choice, and as JSON and pairs', async () => {
    const major = block_dev.register(0, 'hwtest')
    const disk = new GenDisk({ major, name: 'sdz', ops: {}, capacity: 4194304, minors: 16, removable: true }) // 2 GiB
    disk.add()
    disk.add_partition(1, 2048, 1048576) // 512 MiB
    disk.add_partition(2, 1050624, 2097152) // 1 GiB
    const pair = (name: string) => { const minor = String([...disk.parts.values()].concat(disk.part0).find(part => part.name === name)!.dev_t.minor); return `${String(major).padStart(3)}:${minor.padEnd(3)}` }

    const tree = await run('lsblk')
    expect(tree.code).toBe(0)
    expect(tree.out).toBe([
      'NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS',
      `sdz    ${pair('sdz')}  1   2G  0 disk`,
      `├─sdz1 ${pair('sdz1')}  0 512M  0 part`,
      `└─sdz2 ${pair('sdz2')}  0   1G  0 part`,
      ''
    ].join('\n'))

    expect((await run('lsblk -l -n -o NAME,TYPE')).out).toBe('sdz  disk\nsdz1 part\nsdz2 part\n')
    expect((await run('lsblk -dn -b -o NAME,SIZE')).out).toBe('sdz 2147483648\n')
    expect((await run('lsblk -n -p -l -o NAME')).out).toBe('/dev/sdz\n/dev/sdz1\n/dev/sdz2\n')
    expect((await run('lsblk -P -d -o NAME,RM,TYPE')).out).toBe('NAME="sdz" RM="1" TYPE="disk"\n')
    const json = JSON.parse((await run('lsblk -J -o NAME,SIZE,RM,TYPE')).out)
    expect(json.blockdevices).toEqual([{ name: 'sdz', size: '2G', rm: true, type: 'disk', children: [{ name: 'sdz1', size: '512M', rm: false, type: 'part' }, { name: 'sdz2', size: '1G', rm: false, type: 'part' }] }])

    disk.del()
    block_dev.unregister(major, 'hwtest')
    expect((await run('lsblk -n')).out).toBe('')
  }, 60000)

  it('lsblk refuses an unknown column and an unknown option', async () => {
    expect(await run('lsblk -o NOPE')).toMatchObject({ code: 1, err: 'lsblk: unknown column: NOPE\n' })
    expect((await run('lsblk --bogus')).code).toBe(1)
  }, 60000)

  it('has the usb and pci buses, and lsusb and lspci list nothing on them', async () => {
    expect(await kernel.filesystem.fs.readdir('/sys/bus/usb/devices')).toEqual([])
    expect(await kernel.filesystem.fs.readdir('/sys/bus/pci/devices')).toEqual([])
    expect(await run('lsusb')).toEqual({ code: 0, out: '', err: '' })
    expect(await run('lspci')).toEqual({ code: 0, out: '', err: '' })
  }, 60000)
})
