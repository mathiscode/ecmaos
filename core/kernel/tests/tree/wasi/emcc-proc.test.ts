import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/**
 * One program, built with `emcc` and libecmaos (`core/utils/wasm/lib/ecmaos.sh`) and on WALI's musl
 * (`fixtures/wali.build.sh`), spawns, waits, execs and takes signals. Both C libraries make the same spawn call
 * (`src/bin/spawn.mjs`); the signals are each host's (`wasip1.mjs` with libecmaos's `signal.c`, and
 * `wali-host.mjs`).
 */
describe.each(['emcc-proc', 'wali-proc'])('processes and signals in %s', program => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({ credentials: { username: 'root', password: 'root' }, dom: TestDomOptions, filesystem: DefaultFilesystemOptions, log: TestLogOptions })
    await kernel.boot()
  })

  it('spawns, waits, execs and handles signals', async () => {
    const { readFileSync } = process.getBuiltinModule('node:fs')
    const bytes = readFileSync(`${process.cwd()}/tests/tree/wasi/fixtures/${program}.wasm`)
    await kernel.filesystem.fs.writeFile(`/tmp/${program}`, new Uint8Array(bytes), { mode: 0o755 })
    const code = await kernel.shell.execute(`/tmp/${program} > /tmp/${program}.out 2> /tmp/${program}.err`)
    const read = (path: string) => kernel.filesystem.fs.readFile(path, 'utf8')
    expect({ code, out: await read(`/tmp/${program}.out`), err: await read(`/tmp/${program}.err`) }).toEqual({
      code: 0,
      err: '',
      out: [
        'addopen: exit=7 wrote=from the child',
        'pipe: from the child',
        'cloexec: plain open, cloexec closed',
        'execve: exit=0 plain open, cloexec closed',
        'wnohang: 0 then pid, exit=3',
        'signaled: 1 sig=15',
        'spawnp: 0 exit=3 missing=No such file or directory',
        'system: exit=5 popen: through the shell pclose=0',
        'raise: 1 blocked: 1 pending=1 unblocked: 2 ignored usr2: alive',
        'inherited: exit=0 usr2 survived, usr1 blocked=1',
        'sigchld: 1 wait=pid',
        'alarm: handled=2 sleep cut short=1, pause returned',
        ''
      ].join('\n')
    })
  }, 60_000)
})
