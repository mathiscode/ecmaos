import type { Process } from '@zenfs/linux'

import type { Shell } from '@ecmaos/types'

import type { Kernel } from '#kernel.ts'

/**
 * A device's command line (`/dev/battery status`), run under a real process. The `cli` stays on the main thread (it
 * calls `navigator.*`); `/bin/devcli` is the worker process standing for it, with a pid, signals and an exit code.
 * The `cli` gets the `kernel` and `shell` and a `terminal` whose output goes to the process's stdout through a pipe
 * fd (`Kernel.attachStream`), so redirection and pipes work. Output after it returned lands on the live terminal.
 */

const running = new WeakMap<Process, Promise<number>>()

export function startDeviceCli(kernel: Kernel, proc: Process, shell: Shell | undefined, name: string, args: string[]): number {
  const device = kernel.devices.get(name)?.device
  if (!device?.cli) throw new Error(`${name}: no such device or it has no command line`)

  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const output = new ReadableStream<Uint8Array>({ start: c => { controller = c } })
  const { fd, stop } = kernel.attachStream(proc, 'read', output)

  let open = true
  const emit = (text: string | Uint8Array) => {
    if (!open) return kernel.terminal.write(text)
    controller.enqueue(typeof text === 'string' ? encoder.encode(text) : text)
  }

  const terminal = new Proxy(kernel.terminal, {
    get(target, property) {
      if (property === 'write') return (data: string | Uint8Array) => emit(data)
      if (property === 'writeln') return (data: string | Uint8Array = '') => emit(typeof data === 'string' ? data + '\n' : data)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })

  const finish = () => {
    if (!open) return
    open = false
    controller.close()
  }

  void proc.exited.then(() => { finish(); stop() })

  running.set(proc, (async () => {
    try {
      const code = await device.cli!({ args, kernel, pid: proc.pid, shell: shell ?? kernel.shell, terminal })
      return typeof code === 'number' && code >= 0 ? code : (code ? 1 : 0)
    } catch (error) {
      emit(`${name}: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    } finally {
      finish()
    }
  })())

  return fd
}

/** The exit code of the `cli` started for `proc`, once it has finished. */
export function waitDeviceCli(proc: Process): Promise<number> {
  return running.get(proc) ?? Promise.resolve(1)
}
