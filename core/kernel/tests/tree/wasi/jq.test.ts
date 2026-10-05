import { beforeAll, describe, expect, it } from 'vitest'

import { Kernel } from '#kernel.ts'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from '../fixtures/kernel.fixtures'

/** `/bin/jq` is jq built to WebAssembly (`core/utils/wasm/jq/build.sh`) and run as a worker program. */
describe('jq', () => {
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
    const code = await kernel.shell.execute(`${command} > /tmp/jq.out 2> /tmp/jq.err`)
    return {
      code,
      out: await kernel.filesystem.fs.readFile('/tmp/jq.out', 'utf8'),
      err: await kernel.filesystem.fs.readFile('/tmp/jq.err', 'utf8')
    }
  }

  it('filters JSON from standard input', async () => {
    expect(await run(`echo '{"a":[1,2,{"b":3}],"c":"x"}' | jq -c '.a[2].b, .c, (.a | length)'`)).toEqual({ code: 0, out: '3\n"x"\n3\n', err: '' })
  }, 30000)

  it('reads a file, with raw output and the -e exit status', async () => {
    await kernel.filesystem.fs.writeFile('/tmp/people.json', '[{"name":"ada","age":36},{"name":"alan","age":41}]\n')
    expect(await run(`jq -r '.[] | select(.age > 40) | .name' /tmp/people.json`)).toEqual({ code: 0, out: 'alan\n', err: '' })
    expect((await run(`jq -e '.[] | select(.age > 99)' /tmp/people.json`)).code).toBe(4)
  }, 30000)

  it('has regular expressions, dates and arithmetic', async () => {
    const result = await run(`jq -n -c '["foo bar", "baz"] | map(test("ba[rz]")), ("2024-03-05T10:20:30Z" | fromdateiso8601), (1700000000 | todate), ([1,2,3] | add / length)'`)
    expect(result).toEqual({ code: 0, out: '[true,true]\n1709634030\n"2023-11-14T22:13:20Z"\n2\n', err: '' })
  }, 30000)

  it('parses dates by name and format (strptime)', async () => {
    const result = await run(`jq -n -c '("Tuesday, March 05, 2024" | strptime("%A, %B %d, %Y") | mktime), ("3:04 PM 2020-02-29" | strptime("%I:%M %p %Y-%m-%d") | [.[3], .[4], .[6], .[7]])'`)
    expect(result).toEqual({ code: 0, out: '1709596800\n[15,4,6,59]\n', err: '' })
  }, 30000)

  it('reports a parse error on stderr and exits 5, as jq does', async () => {
    const result = await run(`echo '{bad' | jq .`)
    expect(result.code).toBe(5)
    expect(result.err).toMatch(/parse error/i)
  }, 30000)
})
