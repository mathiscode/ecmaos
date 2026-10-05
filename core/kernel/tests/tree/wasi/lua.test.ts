import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/lua` is Lua 5.4 built to WebAssembly (`core/utils/wasm/lua/build.sh`) and run as a worker program. */
describe('lua', () => {
  let kernel: Kernel

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions,
      log: TestLogOptions
    })
    await kernel.boot()
  })

  const run = async (command: string) => {
    const code = await kernel.shell.execute(`${command} > /tmp/lua.out 2> /tmp/lua.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/lua.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/lua.err', 'utf8')
    }
  }

  it('runs a chunk given with -e', async () => {
    expect(await run(`lua -e 'print(_VERSION, 6 * 7, ("x"):rep(3))'`)).toEqual({ code: 0, out: 'Lua 5.4\t42\txxx\n', err: '' })
  }, 30000)

  it('runs a script file with arguments, and reads standard input', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/sum.lua', 'local t = 0\nfor i = 1, #arg do t = t + tonumber(arg[i]) end\nprint(t, io.read("l"))\n')
    expect(await run(`echo hello | lua /tmp/sum.lua 1 2 3`)).toEqual({ code: 0, out: '6\thello\n', err: '' })
  }, 30000)

  it('has the standard library: string patterns, tables, math, os.time, and file io', async () => {
    const script = [
      `local words = {}`,
      `for w in ("the quick brown fox"):gmatch("%a+") do words[#words + 1] = w:upper() end`,
      `table.sort(words)`,
      `print(table.concat(words, ","), math.floor(3.7), math.maxinteger, os.time{year=2024, month=3, day=5, hour=12} > 0)`,
      `local f = assert(io.open("/tmp/lua-io.txt", "w")); f:write("a\\nb\\n"); f:close()`,
      `for l in io.lines("/tmp/lua-io.txt") do io.write(l, ";") end print()`
    ].join('\n')
    await kernel.filesystem.fs.writeFile('/tmp/std.lua', script)
    expect(await run(`lua /tmp/std.lua`)).toEqual({ code: 0, out: 'BROWN,FOX,QUICK,THE\t3\t9223372036854775807\ttrue\na;b;\n', err: '' })
  }, 30000)

  it('runs shell commands with os.execute', async () => {
    expect(await run(`lua -e 'print(os.execute("echo hi; exit 3"))'`)).toEqual({ code: 0, out: 'hi\nnil\texit\t3\n', err: '' })
  }, 30000)

  it('reports a runtime error with a traceback on stderr and exits 1', async () => {
    const result = await run(`lua -e 'error("boom")'`)
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/boom/)
    expect(result.err).toMatch(/traceback/)
  }, 30000)

  it('reports a syntax error and a missing file', async () => {
    expect((await run(`lua -e 'x ='`)).err).toMatch(/unexpected symbol|expected/)
    expect((await run(`lua /tmp/nope.lua`)).code).toBe(1)
  }, 30000)
})
