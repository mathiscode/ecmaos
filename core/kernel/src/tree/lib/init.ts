/**
 * The kernel's half of pid 1: the `Process` itself, and what `/sbin/init` (a worker program, see
 * `@ecmaos/coreutils`' `commands-execve/init.mjs`) cannot do from a worker.
 *
 * pid 1 is `@zenfs/core`'s reserved default context id, and upstream already treats it as init:
 * `Process.exit()` reparents orphans to `processes.get(1)`, and `kill()` ignores any signal pid 1 has
 * not asked to catch. Nothing created a `Process` for it until now.
 *
 * It gets its own context rather than running on `defaultContext`. The default context's descriptor
 * table is the one the kernel's own fs calls open files in, so init's stdio would land on whichever
 * numbers happened to be free (a stray kernel descriptor at fd 1 is enough), and init exiting would
 * close the kernel's files. But the context must still *be* pid 1: `/proc/<pid>/status` takes `PPid`
 * from `context.parent.id`, so a child of init reads 1 only if init's context id is 1. The id cannot be
 * assigned after the fact, so the context is a thin object over a freshly bound one that overrides
 * `id`; every other field (descriptors, credentials, children) is the bound context's own. That
 * context's own registry entry is dropped so `ps` shows no ghost row for it.
 *
 * Three custom syscalls serve the program (`init_wait`, `init_booted`, `init_script`, registered in
 * `main-thread-syscalls.ts`). `init_wait` is not `waitpid`: that takes a snapshot of the children when
 * called, fails with `ECHILD` when there are none, and a signal does not wake it.
 */

import { bindContext, boundContexts } from '@zenfs/core'
import { execve, kill as zenfsKill, Process, processes, WaitQueue, wait_event_any } from '@zenfs/linux'

import type { Kernel } from '#kernel.ts'
import { forgetGroup, setpgid } from './job-control.ts'
import { registerProcessKernel } from './main-thread-syscalls.ts'

export const INIT_PATH = '/sbin/init'

/** How long boot waits for `/sbin/init` to report that its `sysinit` and `wait` entries are done. */
export const INIT_BOOT_TIMEOUT_MS = 60_000

export class Init {
  /** Woken whenever an adopted child exits, which is what `init_wait` sleeps on. */
  readonly events = new WaitQueue()
  private _process?: Process
  private readonly booted = Promise.withResolvers<void>()

  get process(): Process | undefined { return this._process }

  /** Creates pid 1 and starts `/sbin/init` on it. */
  async start(kernel: Kernel): Promise<void> {
    // pid 1 starts with the mask Linux gives it, which every daemon, getty and cron job under it inherits
    // (ignored by an @zenfs/core that has no creation mask)
    const init: Parameters<typeof bindContext>[0] & { umask?: number } = { root: '/', pwd: '/', umask: 0o022 }
    const base = bindContext(init)
    boundContexts.delete(base.id)
    const context = Object.create(base, { id: { value: 1, enumerable: true } }) as typeof base
    const proc = new Process({ context, argv: [INIT_PATH], env: kernel.shell.envObject, console: '/dev/null', tty: null })
    this._process = proc
    this.watchChildren(proc)
    registerProcessKernel(proc, kernel, kernel.shell)
    // Whatever was created before init existed, such as the kernel shell's own process, has no parent.
    for (const orphan of [...processes.values()]) if (orphan !== proc && !orphan.parent && orphan.code === undefined) this.adopt(orphan)
    await execve(proc, INIT_PATH, [INIT_PATH], kernel.shell.envObject)
  }

  /**
   * Makes `child` a child of init. Done after construction, not by passing `parent` to the
   * constructor: a `Process` built with a parent copies the parent's descriptors and skips opening its
   * own console, which would put every command on init's stdio instead of its terminal's.
   */
  adopt(child: Process): void {
    const init = this._process
    if (!init || child === init || child.parent) return
    child.parent = init
    init.children.add(child)
    setpgid(init, child.pid, 0)
    void child.exited.then(() => forgetGroup(child.pid))
  }

  /**
   * Wakes `init_wait` when any child of init exits, however it became one: adopted by the kernel,
   * spawned by init itself, or handed over by upstream when its parent exited (which does nothing but
   * `init.children.add(child)`). Hooking the set catches all three.
   */
  private watchChildren(init: Process): void {
    const children = new Set<Process>()
    const add = children.add.bind(children)
    children.add = (child: Process) => {
      add(child)
      void child.exited.then(() => this.events.wake_up())
      return children
    }
    // `children` is only readonly in the type declaration; upstream itself mutates the set it holds.
    ;(init as { children: Set<Process> }).children = children
  }

  /**
   * Resolves to the pid of a child that has exited, which is reaped, or to 0 once `timeoutMs` passes
   * (a negative number waits for ever).
   * @throws EINTR when a signal arrives first
   */
  async wait(timeoutMs: number): Promise<number> {
    const init = this._process
    if (!init) return 0
    const exited = () => [...init.children].find(child => child.code !== undefined)
    if (!await wait_event_any([this.events], () => !!exited(), init, timeoutMs)) return 0
    const done = exited()!
    const pid = done.pid
    done.reap()
    return pid
  }

  /**
   * Runs a kernel-shell script as a child of init: a `Process` that exits with the script's status, so
   * init reaps it and waits for it like any other entry. It has no thread and no program loaded;
   * `run` does the work on the main thread, where the shell lives.
   */
  script(kernel: Kernel, path: string, args: string[], run: () => Promise<number>): number {
    const child = new Process({ argv: [path, ...args], env: kernel.shell.envObject, console: '/dev/null', tty: null })
    child.exe = path
    registerProcessKernel(child, kernel, kernel.shell)
    this.adopt(child)
    void run().then(code => child.exit(code), error => {
      kernel.log.error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      child.exit(1)
    })
    return child.pid
  }

  /**
   * Every live process that going down should stop: running programs and the boot scripts init
   * started. Not init, and not the kernel's own processes (the shell's identity process, the pipe
   * anchor), which have no program loaded and stay for as long as the kernel does.
   */
  private killable(): Process[] {
    return [...processes.values()].filter(proc => proc !== this._process && proc.code === undefined && proc.exe !== undefined)
  }

  /** Sends `signal` to every {@link killable} process. Resolves to how many were signalled. */
  killAll(signal: number): number {
    let count = 0
    for (const proc of this.killable()) if (zenfsKill(proc.pid, signal)) count++
    return count
  }

  /** How many {@link killable} processes are still alive. */
  alive(): number {
    return this.killable().length
  }

  markBooted(): void {
    this.booted.resolve()
  }

  /** Whether `/sbin/init` reported that boot finished before `timeoutMs` ran out. */
  async waitForBoot(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })
    try {
      return await Promise.race([this.booted.promise.then(() => true), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
