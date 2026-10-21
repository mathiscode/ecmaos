/**
 * Threads of a WALI program (`bin/wali-host.mjs`): each is a process of the kernel's, with a worker of its own running
 * another instance of the program on the same shared memory. Its context inherits from the process's first thread's
 * (its leader's), so it has the same descriptor table, working directory and credentials, and only its id (which is
 * its pid, the thread id) is its own. A thread has no parent, so nothing waits for it and it is reaped as it ends; the
 * program sees the leader's pid as its own.
 *
 * Ending one thread leaves the descriptors it shares alone. `exit()` in any thread ends the process
 * (`proc_exit_group`), and the leader's end, however it comes, ends its threads.
 */
import { define_syscall, Process, Thread, type Process as ProcessType } from '@zenfs/linux'
import { bindContext, fs } from '@zenfs/core'
import { Errno } from 'kerium'
import { inheritUmask } from './umask-store.ts'
import { joinThreadGroup } from './job-control.ts'

declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    proc_thread(exe: string, interpreter: string, memory: WebAssembly.Memory, shared: SharedArrayBuffer, arg: number): number
    proc_exit_group(code: number): number
  }
}

/** Each thread's leader, and each leader's threads */
const leaders = new WeakMap<ProcessType, ProcessType>()
const threads = new WeakMap<ProcessType, Set<ProcessType>>()
/** Each thread's context of its own, with its own (empty) table, which it ends with */
const ownContexts = new WeakMap<ProcessType, ProcessType['context']>()

export const leaderOf = (proc: ProcessType) => leaders.get(proc) ?? proc

/** What upstream keeps read-only or protected, which a thread needs set: its context, and the worker it posts to */
type Settable = { context: ProcessType['context'] }
type Hosted = { host?: { post(message: unknown): void } }
const readFile = fs.readFileSync as unknown as (this: unknown, path: string) => Uint8Array

let installed = false
export function installThreads(): void {
  if (installed) return
  installed = true

  const exit = Process.prototype.exit
  Process.prototype.exit = function (this: ProcessType, ...args: Parameters<typeof exit>) {
    // a thread's table is the process's: it ends with a table of its own, empty, so nothing is closed
    const own = ownContexts.get(this)
    if (own && this.code === undefined) (this as Settable).context = own
    const result = exit.apply(this, args)
    for (const thread of [...(threads.get(this) ?? [])]) thread.exit(args[0])
    return result
  }

  /** `pthread_create`: a thread of the caller's process, running `arg` through `__wasm_thread_start_libc`. @returns its id */
  define_syscall('proc_thread', async (proc: ProcessType, exe: string, interpreter: string, memory: WebAssembly.Memory, shared: SharedArrayBuffer, arg: number) => {
    const leader = leaderOf(proc)
    if (leader.code !== undefined) throw Object.assign(new Error('No such process'), { errno: Errno.ESRCH })
    // made with a context of its own, which gives it its id and takes the constructor's console, and then given one
    // that is the leader's but for the id
    const own = bindContext.call(leader.context, { pwd: leader.context.pwd })
    const thread = new Process({ argv: leader.argv, env: { __WALI_THREAD__: '1' }, context: own, tty: leader.tty, console: '/dev/null' })
    for (const fd of [...own.descriptors.keys()]) fs.closeSync.call(own, fd)
    ownContexts.set(thread, own)
    ;(thread as Settable).context = Object.create(leader.context, { id: { value: own.id } }) as ProcessType['context']
    thread.caps = leader.caps
    leaders.set(thread, leader)
    let siblings = threads.get(leader)
    if (!siblings) threads.set(leader, (siblings = new Set()))
    siblings.add(thread)
    void thread.exited.then(() => siblings.delete(thread))
    inheritUmask(leader, thread)
    joinThreadGroup(thread, leader)
    const data = readFile.call(leader.context, interpreter)
    thread.thread = new Thread(thread)
    await thread.thread.start(exe, interpreter, data)
    ;(thread.thread as unknown as Hosted).host?.post({ $: 'wali-thread', memory, shared, arg, tgid: leader.pid })
    return thread.pid
  })

  define_syscall('proc_exit_group', (proc: ProcessType, code: number) => {
    leaderOf(proc).exit(code)
    return 0
  })
}
