import { beforeAll, describe, expect, it } from 'vitest'
import { syscalls } from '@zenfs/linux'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

/** ipcs and ipcrm, over System V IPC objects the kernel's own process makes (`tree/lib/sysv-ipc.ts`) */
describe('ipcs and ipcrm', () => {
  let kernel: Kernel
  let serial = 0
  const IPC_CREAT = 0o1000

  const sh = async (command: string) => {
    const base = `/tmp/ipc-${serial++}`
    const code = await kernel.shell.execute(`${command} > ${base}.out 2> ${base}.err`)
    const read = (suffix: string) => kernel.filesystem.fs.readFile(`${base}.${suffix}`, 'utf-8').catch(() => '')
    return { code, out: await read('out'), err: await read('err') }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (name: string, ...args: unknown[]) => (syscalls.get(name as never) as any)(kernel.pipeProcess, ...args) as Promise<number> | number

  let queue: number, set: number, segment: number

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
    queue = await call('ipc_get', 'msg', 0x1234, 0, IPC_CREAT | 0o600)
    await call('msg_send', queue, 1, new TextEncoder().encode('hello'), 0)
    set = await call('ipc_get', 'sem', 0x5678, 3, IPC_CREAT | 0o640)
    segment = await call('ipc_get', 'shm', 0, 8192, IPC_CREAT | 0o600)
  }, 60000)

  it('/proc/sysvipc lists them as Linux does', async () => {
    const msg = await kernel.filesystem.fs.readFile('/proc/sysvipc/msg', 'utf-8')
    expect(msg.split('\n')[0]).toBe('       key      msqid perms      cbytes       qnum lspid lrpid   uid   gid  cuid  cgid      stime      rtime      ctime')
    expect(msg.split('\n')[1]).toMatch(new RegExp(`^ {6}4660 {1,10}${queue}   600 {11}5 {10}1 `))
    expect(await kernel.filesystem.fs.readFile('/proc/sysvipc/sem', 'utf-8')).toMatch(new RegExp(`^ {5}22136 {1,10}${set}   640 {10}3 `, 'm'))
    expect(await kernel.filesystem.fs.readFile('/proc/sysvipc/shm', 'utf-8')).toMatch(new RegExp(`^ {9}0 {1,10}${segment}   600 {18}8192 `, 'm'))
  }, 30000)

  it('ipcs shows each kind, or the ones asked for', async () => {
    const all = await sh('ipcs')
    expect(all.code).toBe(0)
    expect(all.out).toMatch(/^------ Message Queues --------\nkey +msqid +owner +perms +used-bytes +messages +\n/m)
    expect(all.out).toMatch(new RegExp(`^0x00001234 ${queue} +root +600 +5 +1 +$`, 'm'))
    expect(all.out).toMatch(new RegExp(`^0x00000000 ${segment} +root +600 +8192 +0 +`, 'm'))
    expect(all.out).toMatch(new RegExp(`^0x00005678 ${set} +root +640 +3 +$`, 'm'))
    const queues = await sh('ipcs -q')
    expect(queues.out).toContain('Message Queues')
    expect(queues.out).not.toContain('Semaphore Arrays')
  }, 30000)

  it('ipcrm removes by key and by id, says which it could not, and -a removes the rest', async () => {
    expect(await sh(`ipcrm -Q 0x1234 -m ${segment}`)).toEqual({ code: 0, out: '', err: '' })
    expect((await sh('ipcs -q -m')).out).not.toMatch(/^0x/m)
    const missing = await sh('ipcrm -q 999 -S 0x9999')
    expect(missing.code).toBe(1)
    expect(missing.err).toBe('ipcrm: invalid id (999)\nipcrm: invalid key (0x9999)\n')
    expect((await sh('ipcrm -a')).code).toBe(0)
    expect((await sh('ipcs')).out).not.toMatch(/^0x/m)
  }, 30000)
})
