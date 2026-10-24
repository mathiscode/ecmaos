import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * The toybox programs that read `/proc`: `ps`, `lsof`, `vmstat`, `netstat`, `sysctl`, `lsmod`, `pidof`. They are run as
 * they are on Linux, against the files `proc-extras.ts` adds and the ones @zenfs/linux has.
 */
describe('toybox: ps, lsof, vmstat, netstat, sysctl, lsmod, pidof', () => {
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
    // the programs are installed in the background; wait until the last one starts
    for (let tries = 0; tries < 100 && await kernel.shell.execute('pidof init > /dev/null 2>&1') !== 0; tries++) await new Promise(resolve => setTimeout(resolve, 500))
  }, 120000)

  const sh = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/t.out 2> /tmp/t.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/t.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/t.err', 'utf8')
    }
  }

  it('ps -e -o lists every process, with init as 1 and the choice of columns', async () => {
    const ran = await sh('ps -e -o pid,ppid,user,comm')
    expect(ran.code, ran.err).toBe(0)
    const rows = ran.out.trim().split('\n').map(line => line.trim().split(/\s+/))
    expect(rows[0]).toEqual(['PID', 'PPID', 'USER', 'COMM'])
    expect(rows).toContainEqual(['1', '0', 'root', 'init'])
    expect(rows.some(row => row[3] === 'ps')).toBe(true)
  }, 60000)

  it('ps aux and ps -ef print the headers of the BSD and the SysV listings', async () => {
    const aux = await sh('ps aux')
    expect(aux.code, aux.err).toBe(0)
    expect(aux.out.split('\n')[0]).toMatch(/^USER +PID +%CPU +%MEM +VSZ +RSS +TTY +STAT +STIME +TIME +ARGS/)
    expect(aux.out).toMatch(/^root +1 .* init$/m)
    const sysv = await sh('ps -ef')
    expect(sysv.out.split('\n')[0]).toMatch(/^UID +PID +PPID +C +STIME +TTY +TIME +CMD/)
  }, 60000)

  it('ps -p names a process and its state, parent and group come from /proc/<pid>/stat', async () => {
    const ran = await sh('ps -o pid=,ppid=,pgid=,stat= -p 1')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out.trim().split(/\s+/)).toEqual(['1', '0', '1', 'Ss'])
  }, 60000)

  it('pidof finds a program by name', async () => {
    expect((await sh('pidof init')).out).toBe('1\n')
    expect((await sh('pidof no-such-program')).code).toBe(1)
  }, 60000)

  it('lsof lists a process\'s working directory, its program and the descriptors it holds', async () => {
    const ran = await sh('lsof -p 1')
    expect(ran.code, ran.err).toBe(0)
    expect(ran.out.split('\n')[0]).toMatch(/^COMMAND +PID +USER +FD +TYPE/)
    expect(ran.out).toMatch(/^init +1 +root +cwd +DIR .* \/$/m)
    expect(ran.out).toMatch(/^init +1 +root +txt +REG .* \/sbin\/init$/m)
  }, 60000)

  it('vmstat gives its header and a row of counters', async () => {
    const ran = await sh('vmstat')
    expect(ran.code, ran.err).toBe(0)
    const [banner, header, row] = ran.out.trim().split('\n')
    expect(banner).toContain('procs')
    expect(header!.trim().split(/\s+/)).toEqual(['r', 'b', 'swpd', 'free', 'buff', 'cache', 'si', 'so', 'bi', 'bo', 'in', 'cs', 'us', 'sy', 'id', 'wa'])
    expect(row!.trim().split(/\s+/)).toHaveLength(16)
  }, 60000)

  it('sysctl reads and sets what /proc/sys has', async () => {
    expect((await sh('sysctl -n kernel.ostype')).out).toBe('Linux\n')
    expect((await sh('sysctl -n net.ipv4.ip_local_port_range')).out).toBe('49152\t65535\n')
    expect((await sh('sysctl -n kernel.pid_max')).out).toBe('4194304\n')
    expect((await sh('sysctl -w kernel.hostname=probe')).out).toBe('kernel.hostname = probe\n')
    expect((await sh('sysctl -n kernel.hostname')).out).toBe('probe\n')
  }, 60000)

  it('lsmod has its header', async () => {
    expect((await sh('lsmod')).out).toMatch(/^Module +Size +Used by\n/)
  }, 60000)

  it('netstat lists a listening socket from /proc/net/tcp', async () => {
    await sh('dropbearkey -t ed25519 -f /tmp/hostkey')
    void kernel.shell.execute('dropbear -F -E -s -r /tmp/hostkey -p 127.0.0.1:2424 > /tmp/server.out 2>&1')
    let listing = ''
    for (let tries = 0; tries < 100 && !listing.includes(':2424'); tries++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      listing = (await sh('netstat -ltn')).out
    }
    expect(listing).toMatch(/^tcp +0 +0 +127\.0\.0\.1:2424 +0\.0\.0\.0:\* +LISTEN/m)
    // ss reads the same table
    const sockets = await sh('ss -ltn')
    expect(sockets.out.split('\n')[0]).toMatch(/^State +Recv-Q +Send-Q +Local Address:Port +Peer Address:Port/)
    expect(sockets.out).toMatch(/^LISTEN +0 +4096 +127\.0\.0\.1:2424 +0\.0\.0\.0:\*$/m)
    expect((await sh('ss -ltn -H')).out.split('\n')[0]).toMatch(/^LISTEN /)
    expect((await sh('ss -lun')).out).not.toContain(':2424')
    await kernel.shell.execute('pkill dropbear')
  }, 60000)
})
