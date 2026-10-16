import { beforeAll, expect } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './kernel.fixtures'

/**
 * Boots one kernel for the enclosing `describe` and returns the helpers the POSIX file operation tests share.
 * Each case builds its own tree under /tmp/posix and compares stdout, stderr and the exit status.
 */
export function usePosixKernel() {
  let kernel: Kernel
  let serial = 0
  const fs = () => kernel.filesystem.fs

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
    const container = document.createElement('div')
    document.body.appendChild(container)
    kernel.terminal.mount(container)
  })

  /** Run `command` in the directory `dir`; returns what it printed and its status */
  async function runIn(dir: string, command: string) {
    const prefix = `cd ${dir}; `
    const base = `/tmp/posix/o${++serial}`
    const code = await kernel.shell.execute(`${prefix}${command} >${base}.out 2>${base}.err`)
    const read = async (path: string) => (await fs().readFile(path, 'utf-8')) as string
    return { code, out: await read(`${base}.out`), err: await read(`${base}.err`), dir, exists: (path: string) => fs().exists(`${dir}/${path}`) }
  }

  /** Run `command` in a fresh directory prepared by `setup` (a shell script) */
  async function run(setup: string, command: string) {
    const dir = `/tmp/posix/c${++serial}`
    await fs().mkdir(dir, { recursive: true })
    if (setup) expect(await kernel.shell.execute(`cd ${dir}; ${setup}`)).toBe(0)
    return runIn(dir, command)
  }

  return { run, runIn, fs, get kernel() { return kernel } }
}
