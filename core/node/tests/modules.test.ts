import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Session } from './session.ts'

const supported = Number(process.versions.node.split('.')[0]) >= 24

// the file is made with printf: the header is one line a field
const file = String.raw`printf '/* ecmaos-module\n * name=hello\n * version=1.0.0\n * license=GPL-2.0-only\n * parm=times:number:How often\n */\nexport default { init(ctx) { ctx.export("hello.times", ctx.param("times")) } }\n' > /tmp/hello.ko.mjs`

describe.skipIf(!supported)('kernel modules on the Node host', () => {
  const session = new Session()

  beforeAll(async () => { await session.ready() })
  afterAll(async () => { await session.stop() })

  it('loads, lists, reads and unloads a module', async () => {
    await session.run(file)
    expect(await session.run('modinfo /tmp/hello.ko.mjs')).toContain('name:           hello')
    expect(await session.run('insmod /tmp/hello.ko.mjs times=2; echo exit $?')).toBe('exit 0')
    expect(await session.run('lsmod')).toMatch(/^hello +[1-9]\d* +0 *$/m)
    expect(await session.run('cat /sys/module/hello/parameters/times')).toBe('2')
    expect(await session.run('cat /proc/kallsyms')).toContain('hello.times')
    expect(await session.run('cat /proc/sys/kernel/tainted')).toBe(String((1 << 12) | (1 << 13)))
    expect(await session.run('rmmod hello; echo exit $?')).toBe('exit 0')
    expect(await session.run('lsmod')).not.toContain('hello')
  })
})
