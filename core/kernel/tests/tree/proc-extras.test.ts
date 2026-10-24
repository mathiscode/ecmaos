import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/**
 * The files of `/proc` that `ps`, `lsof`, `vmstat` and `netstat` read: `stat`, `loadavg`, `<pid>/stat`, and `net/`.
 */
describe('/proc: stat, loadavg, <pid>/stat and net/', () => {
  let kernel: Kernel
  const fs = () => kernel.filesystem.fs
  const text = (path: string) => fs().readFile(path, 'utf8')

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

  it('/proc/stat has the aggregate line, one line per core, and the boot time', async () => {
    const stat = await text('/proc/stat')
    const lines = stat.split('\n')
    expect(lines[0]).toMatch(/^cpu {2}\d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+$/)
    expect(lines.filter(line => /^cpu\d+ /.test(line))).toHaveLength(navigator.hardwareConcurrency || 1)
    expect(stat).toMatch(/^btime \d{10}$/m)
    expect(stat).toMatch(/^procs_running \d+$/m)
  })

  it('/proc/loadavg has three averages, running/total and the last pid', async () => {
    expect(await text('/proc/loadavg')).toMatch(/^\d+\.\d\d \d+\.\d\d \d+\.\d\d \d+\/\d+ \d+\n$/)
  })

  it('/proc/<pid>/stat has the 52 fields with the command in parentheses', async () => {
    await kernel.shell.execute('cat /proc/self/stat > /tmp/self.stat')
    const stat = await text('/tmp/self.stat')
    const match = /^(\d+) \((.*)\) (\S) (.*)\n$/.exec(stat)
    expect(match, stat).not.toBeNull()
    expect(match![2]).toBe('cat')
    // 52 fields: pid, comm and state, then 49 more
    expect(match![4]!.split(' ')).toHaveLength(49)
    const pid = Number(match![1])
    expect(pid).toBeGreaterThan(0)
    expect(await text(`/proc/${pid}/statm`).catch(() => 'gone')).toBeDefined()
  })

  it('/proc/net has the tables Linux has, empty of sockets before any are open', async () => {
    const names = await fs().readdir('/proc/net')
    expect(names).toEqual(expect.arrayContaining(['tcp', 'tcp6', 'udp', 'udp6', 'unix', 'dev', 'route', 'if_inet6']))
    expect(await text('/proc/net/tcp')).toMatch(/^ {2}sl {2}local_address rem_address {3}st tx_queue/)
    expect(await text('/proc/net/dev')).toMatch(/^ {4}lo: /m)
    expect(await text('/proc/net/if_inet6')).toBe('00000000000000000000000000000001 01 80 10 80       lo\n')
  })

  it('a listening socket is a row of /proc/net/tcp in the form Linux prints, with its owner', async () => {
    await kernel.shell.execute('dropbearkey -t ed25519 -f /tmp/hostkey > /dev/null 2>&1')
    void kernel.shell.execute('dropbear -F -E -s -r /tmp/hostkey -p 127.0.0.1:2323 > /tmp/server.out 2>&1')
    let tcp = ''
    for (let i = 0; i < 400 && !tcp.includes(':0913 '); i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      tcp = await text('/proc/net/tcp')
    }
    expect(tcp).toMatch(/^ +0: 0100007F:0913 00000000:0000 0A 00000000:00000000 00:00000000 00000000 +0 +0 \d+ 1 /m)
    await kernel.shell.execute('pkill dropbear')
  }, 60000)
})
