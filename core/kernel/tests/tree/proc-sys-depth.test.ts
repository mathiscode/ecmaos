import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'
import { mountinfo } from '#lib/proc-depth.ts'
import { setHostMemory, showMeminfo } from '#lib/meminfo.ts'

import { PROGRAMS_COREUTILS, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('/proc and /sys depth', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const text = (path: string) => fs().readFile(path, 'utf8')

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions, programs: PROGRAMS_COREUTILS })
    await kernel.boot()
    await kernel.whenProgramsReady()
    await new Promise(resolve => setTimeout(resolve, 100))
  }, 120000)

  describe('/proc/<pid>', () => {
    it('limits has the columns and rows Linux prints', async () => {
      const limits = await text('/proc/1/limits')
      const lines = limits.split('\n')
      expect(lines[0]).toBe('Limit                     Soft Limit           Hard Limit           Units     ')
      expect(lines).toContain('Max open files            1024                 65536                files     ')
      expect(lines.filter(line => line.startsWith('Max '))).toHaveLength(16)
    })

    it('mountinfo names each mount, the one it sits in, and its type and source', async () => {
      const info = (await text('/proc/1/mountinfo')).split('\n').filter(Boolean)
      expect(info.length).toBeGreaterThan(3)
      for (const line of info) expect(line).toMatch(/^\d+ \d+ 0:\d+ \/ \S+ \S+ - \S+ \S+ (rw|ro)$/)
      const proc = info.find(line => line.includes(' /proc '))!
      expect(proc).toContain(' - proc ')
      const parent = Number(proc.split(' ')[1])
      expect(info.find(line => line.startsWith(`${parent} `))).toContain(' / / ')
    })

    it('mountinfo gives a mount inside another the other as its parent', () => {
      const lines = mountinfo('rootfs / idb rw,relatime 0 0\nnone /tmp tmpfs rw,relatime 0 0\nnone /tmp/a/b memory ro,relatime 0 0\n'.replace(/ 0 0/g, '')).split('\n')
      expect(lines[0]).toBe('22 22 0:30 / / rw,relatime - idb rootfs rw')
      expect(lines[1]).toBe('23 22 0:31 / /tmp rw,relatime - tmpfs none rw')
      expect(lines[2]).toBe('24 23 0:32 / /tmp/a/b ro,relatime - memory none ro')
    })

    it('maps and smaps are empty, io is all zero, oom files and wchan are as Linux writes them', async () => {
      expect(await text('/proc/1/maps')).toBe('')
      expect(await text('/proc/1/smaps')).toBe('')
      expect(await text('/proc/1/io')).toBe('rchar: 0\nwchar: 0\nsyscr: 0\nsyscw: 0\nread_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n')
      expect(await text('/proc/1/oom_score')).toBe('0\n')
      expect(await text('/proc/1/oom_score_adj')).toBe('0\n')
      expect(await text('/proc/1/wchan')).toBe('0')
      expect(await text('/proc/1/loginuid')).toBe('4294967295')
    })

    it('ns/ links name the initial namespaces, the same for every process', async () => {
      expect((await fs().readdir('/proc/1/ns')).sort()).toEqual(['cgroup', 'ipc', 'mnt', 'net', 'pid', 'time', 'user', 'uts'])
      expect(await fs().readlink('/proc/1/ns/mnt')).toBe('mnt:[4026531841]')
      expect(await fs().readlink('/proc/1/ns/pid')).toBe('pid:[4026531836]')
    })

    it('/proc/self and task/<pid> have them too', async () => {
      await kernel.shell.execute('cat /proc/self/limits > /tmp/self-limits')
      expect(await text('/tmp/self-limits')).toContain('Max open files')
      expect(await text('/proc/1/task/1/limits')).toBe(await text('/proc/1/limits'))
    })
  })

  describe('/proc', () => {
    it('swaps lists no swap, cgroups no controllers, interrupts a column per core', async () => {
      expect(await text('/proc/swaps')).toBe('Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n')
      expect(await text('/proc/cgroups')).toBe('#subsys_name\thierarchy\tnum_cgroups\tenabled\n')
      const head = (await text('/proc/interrupts')).split('\n')[0]!
      expect(head.match(/CPU\d+/g)).toHaveLength(navigator.hardwareConcurrency || 1)
    })

    it('diskstats has one row per block device /proc/partitions lists', async () => {
      const devices = (await text('/proc/partitions')).split('\n').slice(2).filter(Boolean)
      expect((await text('/proc/diskstats')).split('\n').filter(Boolean)).toHaveLength(devices.length)
    })

    it('the sysctl keys programs ask for are there, and read-only', async () => {
      expect((await text('/proc/sys/kernel/random/boot_id')).trim()).toMatch(/^[0-9a-f-]{36}$/)
      expect(await text('/proc/sys/kernel/random/boot_id')).toBe(await text('/proc/sys/kernel/random/boot_id'))
      expect(await text('/proc/sys/kernel/random/uuid')).not.toBe(await text('/proc/sys/kernel/random/uuid'))
      expect(await text('/proc/sys/vm/swappiness')).toBe('60\n')
      expect(await text('/proc/sys/vm/max_map_count')).toBe('65530\n')
      expect(await text('/proc/sys/fs/nr_open')).toBe('65536\n')
      expect(await text('/proc/sys/net/core/somaxconn')).toBe('4096\n')
      expect(await text('/proc/sys/net/ipv4/ip_local_port_range')).toBe('49152\t65535\n')
      expect(await text('/proc/sys/kernel/pid_max')).toBe('4194304\n')
    })

    it('sysctl reads them', async () => {
      expect(await kernel.shell.execute('sysctl vm.swappiness > /tmp/sysctl-out')).toBe(0)
      expect(await text('/tmp/sysctl-out')).toBe('vm.swappiness = 60\n')
    })
  })

  describe('/proc/meminfo', () => {
    it('reads what the host says, and lists the counters that are 0 because there is nothing to count', () => {
      setHostMemory(() => ({ total: 8 * 1024 ** 3, free: 3 * 1024 ** 3 }))
      try {
        const info = showMeminfo()
        expect(info).toMatch(/^MemTotal: +8388608 kB$/m)
        expect(info).toMatch(/^MemFree: +3145728 kB$/m)
        expect(info).toMatch(/^SwapTotal: +0 kB$/m)
      } finally { setHostMemory(undefined) }
    })

    it('is empty where nothing says how much memory there is', () => {
      if (!('deviceMemory' in navigator) && !performance.memory) expect(showMeminfo()).toBe('')
    })
  })

  describe('/sys', () => {
    it('class/net/lo is the loopback /proc/net/dev lists', async () => {
      expect(await fs().readdir('/sys/class/net')).toEqual(['lo'])
      expect(await text('/sys/class/net/lo/mtu')).toBe('65536\n')
      expect(await text('/sys/class/net/lo/type')).toBe('772\n')
      expect(await text('/sys/class/net/lo/operstate')).toBe('unknown\n')
      expect(await text('/sys/class/net/lo/statistics/rx_bytes')).toBe('0\n')
      expect(await text('/sys/class/net/lo/ifindex')).toBe('1\n')
    })

    it('power_supply has the battery and the mains from the Battery API', async () => {
      expect((await fs().readdir('/sys/class/power_supply')).sort()).toEqual(['AC', 'BAT0'])
      expect(await text('/sys/class/power_supply/BAT0/type')).toBe('Battery\n')
      expect(await text('/sys/class/power_supply/BAT0/capacity')).toBe('100\n')
      expect(await text('/sys/class/power_supply/BAT0/status')).toBe('Full\n')
      expect(await text('/sys/class/power_supply/AC/online')).toBe('1\n')
    })

    it('fs/cgroup is a root with no controllers that holds every live process', async () => {
      expect(await text('/sys/fs/cgroup/cgroup.controllers')).toBe('\n')
      expect(await text('/sys/fs/cgroup/cgroup.stat')).toBe('nr_descendants 0\nnr_dying_descendants 0\n')
      const pids = (await text('/sys/fs/cgroup/cgroup.procs')).split('\n').filter(Boolean)
      expect(pids).toContain('1')
    })

    it('the cpu masks cover every core', async () => {
      const last = (navigator.hardwareConcurrency || 1) - 1
      expect(await text('/sys/devices/system/cpu/online')).toBe(last ? `0-${last}\n` : '0\n')
      expect(await text('/sys/devices/system/cpu/possible')).toBe(last ? `0-${last}\n` : '0\n')
      expect(await text('/sys/devices/system/cpu/kernel_max')).toBe(`${last}\n`)
    })
  })
})
