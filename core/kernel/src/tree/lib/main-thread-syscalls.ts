/**
 * Custom syscalls that cross from a real, worker-isolated `@zenfs/linux` `Process` back onto the
 * main thread, for the handful of capabilities that only exist there (DOM window creation today;
 * Web Bluetooth and the Battery Status API are the reason this module exists at all -- neither is
 * exposed inside a Web Worker by spec, in any browser, ever, so no amount of worker-side code can
 * reach them directly).
 *
 * There is no separate "bridge" to build: `@zenfs/linux`'s own `Thread.syscall` (`thread.js`) already
 * runs `dispatch(this.proc, name, args)` on the main thread for every syscall, sync or async alike,
 * and unconditionally `await`s whatever the handler returns -- confirmed against the installed
 * package, and confirmed as real, working precedent by `read`/`write`/`poll`'s own handlers, which
 * already `await` an indefinite external event (`wait_event`/`wait_event_any` in `wait.js`), not just
 * a fast in-memory operation. `define_syscall` (`syscall/table.js`) is the whole registration surface;
 * this module's only real job is (a) registering a small, typed handler per capability, the same way
 * a Linux syscall is added one at a time, and (b) resolving which `Kernel` instance a given `Process`
 * belongs to, since `@zenfs/linux`'s `Process` has no notion of "kernel" at all and the `syscalls` map
 * is module-global -- shared across every `Kernel` instance in the same page (or test file: several
 * of this repo's own tests construct more than one `Kernel`).
 *
 * A syscall's numeric return (`dispatch`'s contract: a `number`, or a negative `-errno`) is the reason
 * every handler here returns a small integer *handle*, never the real object (`WinBox`, a `Bluetooth-
 * Device`, ...) -- those aren't structured-clone-safe across the syscall boundary in general, and the
 * return path is `i64`-shaped, not "any JS value." A handle is looked up again against `Windows`'s own
 * (or a future device driver's own) manager on each subsequent call, exactly the way a real fd is an
 * integer a program passes back to the kernel rather than the open file itself.
 */

import { define_syscall, type Process } from '@zenfs/linux'
import { Errno } from 'kerium'

import type { Kernel } from '#kernel.ts'

// Declaration merging into `@zenfs/linux`'s own `Syscalls` interface (`uapi/abi.d.ts`) -- the
// intended extension point for a custom syscall's argument/return shape, matching how `define_syscall`
// itself is generic over `keyof Syscalls`. Without this, `define_syscall('window_create', ...)` doesn't
// typecheck: `name` is constrained to the closed set `@zenfs/linux` ships.
declare module '@zenfs/linux/uapi/abi' {
  interface Syscalls {
    window_create(title: string): number
    window_write(handle: number, text: string): number
    window_close(handle: number): number
  }
}

/** Which `Kernel` owns a given real `Process` -- set once, at the one real `execve` call site. */
const kernelOfProcess = new WeakMap<Process, Kernel>()

export function registerProcessKernel(proc: Process, kernel: Kernel): void {
  kernelOfProcess.set(proc, kernel)
}

function kernelOf(proc: Process): Kernel {
  const kernel = kernelOfProcess.get(proc)
  if (!kernel) throw Object.assign(new Error('No kernel registered for this process'), { errno: Errno.ENOSYS })
  return kernel
}

/** Handles the running program can reference; not persisted beyond one boot, same as `Windows` itself. */
let nextWindowHandle = 1
const windowHandles = new Map<number, string>() // handle -> Windows' own WindowId

/**
 * Registers this module's syscalls in `@zenfs/linux`'s module-global `syscalls` table.
 *
 * Idempotent: `define_syscall` throws `EEXIST` on a second registration of the same name, and this
 * module's own registrations must survive more than one `Kernel` being constructed in the same page
 * or test process (confirmed: `kernel.test.ts` and `protocol.test.ts` each construct several) -- so
 * this only ever registers once per process lifetime, tracked here rather than relying on the second
 * `Kernel`'s call silently failing in some more surprising way.
 */
let installed = false
export function installMainThreadSyscalls(): void {
  if (installed) return
  installed = true

  define_syscall('window_create', async (proc: Process, title: string) => {
    const kernel = kernelOf(proc)
    const win = kernel.windows.create({ title: title || 'Untitled' })
    const handle = nextWindowHandle++
    windowHandles.set(handle, String(win.id))
    return handle
  })

  define_syscall('window_write', async (proc: Process, handle: number, text: string) => {
    const kernel = kernelOf(proc)
    const id = windowHandles.get(handle)
    if (!id) return -Errno.EBADF
    const win = kernel.windows.get(id)
    if (!win) return -Errno.EBADF
    win.body.textContent = ((win.body.textContent || '') + text)
    return text.length
  })

  define_syscall('window_close', async (proc: Process, handle: number) => {
    const kernel = kernelOf(proc)
    const id = windowHandles.get(handle)
    if (!id) return -Errno.EBADF
    kernel.windows.close(id)
    windowHandles.delete(handle)
    return 0
  })
}
