import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { PROGRAMS_ALL, TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/make` is GNU make built to WebAssembly (`core/utils-copyleft/wasm/make/build.sh`); it starts its jobs with libecmaos's posix_spawn. */
describe('make', () => {
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
  })

  const run = async (dir: string, makefile: string, args = '') => {
    const fs = kernel.filesystem.fs
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(`${dir}/Makefile`, makefile)
    const code = await kernel.shell.execute(`cd ${dir} && make ${args} > ${dir}/out 2> ${dir}/err`)
    return { code, out: await fs.readFile(`${dir}/out`, 'utf8'), err: await fs.readFile(`${dir}/err`, 'utf8') }
  }

  it('builds a target from its prerequisites, running each recipe line', async () => {
    const result = await run('/tmp/mk1', 'all: b.txt\n\t@echo done\nb.txt: a.txt\n\tcp a.txt b.txt\n\t@echo copied\n')
    expect(result.code).toBe(2)
    expect(result.err).toMatch(/No rule to make target 'a.txt'/)
    await kernel.filesystem.fs.writeFile('/tmp/mk1/a.txt', 'data')
    expect(await run('/tmp/mk1', 'all: b.txt\n\t@echo done\nb.txt: a.txt\n\tcp a.txt b.txt\n\t@echo copied\n')).toEqual({ code: 0, out: 'cp a.txt b.txt\ncopied\ndone\n', err: '' })
    expect(await kernel.filesystem.fs.readFile('/tmp/mk1/b.txt', 'utf8')).toBe('data')
  }, 60000)

  it('uses variables, $(shell), pattern rules and automatic variables', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/mk2', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/mk2/x.in', 'X')
    const result = await run('/tmp/mk2', 'WHO := $(shell echo world)\nall: x.out\n\t@echo hello $(WHO)\n%.out: %.in\n\t@cat $< > $@; echo built $@ from $<\n')
    expect(result).toEqual({ code: 0, out: 'built x.out from x.in\nhello world\n', err: '' })
  }, 60000)

  it('stops on a failing recipe with its status, and -k and - keep going', async () => {
    const result = await run('/tmp/mk3', 'all:\n\t@echo one\n\t@exit 3\n\t@echo two\n')
    expect(result.code).toBe(2)
    expect(result.out).toBe('one\n')
    expect(result.err).toMatch(/Error 3/)
    expect(await run('/tmp/mk3', 'all:\n\t-@exit 3\n\t@echo after\n')).toEqual({ code: 0, out: 'after\n', err: expect.stringMatching(/Error 3.*ignored/) })
  }, 60000)

  it('runs jobs side by side with -j, and a sub-make shares the jobserver', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/mk5/sub', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/mk5/sub/Makefile', 'all: x y\nx:\n\t@sleep 1; echo x\ny:\n\t@echo y\n')
    const result = await run('/tmp/mk5', '.PHONY: sub\nall: slow fast sub\nslow:\n\t@sleep 1; echo slow\nfast:\n\t@echo fast\nsub:\n\t@$(MAKE) --no-print-directory -C sub\n', '-j4')
    expect(result).toEqual({ code: 0, out: expect.any(String), err: '' })
    const lines = result.out.trim().split('\n')
    expect([...lines].sort()).toEqual(['fast', 'slow', 'x', 'y'])
    // the quick jobs finish while the slow ones still sleep
    expect(lines.indexOf('fast')).toBeLessThan(lines.indexOf('slow'))
    expect(lines.indexOf('y')).toBeLessThan(lines.indexOf('x'))
  }, 60000)

  it('does nothing for an up-to-date target and prints with -n', async () => {
    await kernel.filesystem.fs.mkdir('/tmp/mk4', { recursive: true })
    await kernel.filesystem.fs.writeFile('/tmp/mk4/t', '')
    expect((await run('/tmp/mk4', 't:\n\techo ran\n')).out).toMatch(/is up to date/)
    expect((await run('/tmp/mk4', 'x:\n\techo ran\n', '-n')).out).toBe('echo ran\n')
  }, 60000)
})
