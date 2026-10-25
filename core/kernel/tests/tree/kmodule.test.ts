import { afterEach, describe, expect, it } from 'vitest'
import { find_module, modules } from '@zenfs/linux'

import { acceptsApi, ModuleError, ModuleManager, parseModinfo, parseParams } from '#lib/kmodule.ts'

const header = (lines: string[]) => `/* ecmaos-module\n${lines.map(line => ` * ${line}`).join('\n')}\n */\n`

/** A module file; `body` runs when it is evaluated, and must define `init` */
const file = (lines: string[], body = 'export default { init() {} }') => header(lines) + body

const lines: string[] = []
const manager = () => new ModuleManager({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  dmesg: line => lines.push(line),
  evaluate: async source => (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as unknown
})

afterEach(async () => {
  for (const mod of [...modules.values()]) await mod.dispose(true).catch(() => {})
  lines.length = 0
})

describe('modinfo', () => {
  it('reads the header block without running the module', () => {
    const info = parseModinfo(file([
      'name=hello', 'version=1.2.0', 'license=GPL-2.0-only', 'author=A', 'author=B', 'description=Says hello',
      'kernel_api=^1', 'depends=a, b', 'alias=fs-hello', 'parm=greeting:string:The greeting: shown', 'parm=times:number:How often'
    ], 'throw new Error("must not run")'))
    expect(info).toMatchObject({ name: 'hello', version: '1.2.0', license: 'GPL-2.0-only', author: ['A', 'B'], kernelApi: '^1', depends: ['a', 'b'], alias: ['fs-hello'] })
    expect(info.parm).toEqual([{ name: 'greeting', type: 'string', description: 'The greeting: shown' }, { name: 'times', type: 'number', description: 'How often' }])
  })

  it('refuses a file with no header, a bad line, a bad name or a bad parm', () => {
    expect(() => parseModinfo('export default {}')).toThrow(/no ecmaos-module header/)
    expect(() => parseModinfo(header(['name=x', 'oops']))).toThrow(/bad modinfo line/)
    expect(() => parseModinfo(header(['version=1']))).toThrow(/name is missing/)
    expect(() => parseModinfo(header(['name=x', 'parm=a:date:no']))).toThrow(/bad parm/)
  })

  it('checks the kernel_api range', () => {
    expect(acceptsApi(undefined)).toBe(true)
    expect(acceptsApi('^1')).toBe(true)
    expect(acceptsApi('>=1.0.0 <2')).toBe(true)
    expect(acceptsApi('^2')).toBe(false)
    expect(acceptsApi('not a range')).toBe(false)
  })

  it('types parameters and names the bad one', () => {
    const info = parseModinfo(header(['name=x', 'parm=a:number:n', 'parm=b:boolean:b', 'parm=c:string:s']))
    expect(parseParams(['a=3', 'b=yes', 'c="two words"'], info)).toEqual(new Map<string, string | number | boolean>([['a', 3], ['b', true], ['c', 'two words']]))
    expect(() => parseParams(['a=x'], info)).toThrow(/wants a number/)
    expect(() => parseParams(['d=1'], info)).toThrow(/unknown parameter 'd'/)
    expect(() => parseParams(['b=maybe'], info)).toThrow(/wants a boolean/)
  })
})

describe('insmod and rmmod', () => {
  it('loads a module, taints it O and E, and unloads it running exit and the undo steps', async () => {
    const events: string[] = []
    ;(globalThis as Record<string, unknown>).__events = events
    const kmod = manager()
    const mod = await kmod.load(file(['name=hello', 'version=1.0.0', 'parm=times:number:n'], `export default {
      init(ctx) { globalThis.__events.push('init ' + ctx.param('times')); ctx.onExit(() => globalThis.__events.push('undo')) },
      exit() { globalThis.__events.push('exit') }
    }`), { params: ['times=4'] })
    expect(mod.state).toBe('live')
    expect(mod.flags).toBe('OE')
    expect(kmod.tainted).toBe((1 << 12) | (1 << 13))
    expect(find_module('hello')).toBe(mod)
    await kmod.unload('hello')
    expect(events).toEqual(['init 4', 'undo', 'exit'])
    expect(find_module('hello')).toBeNull()
    expect(lines.some(line => line.includes('hello: module 1.0.0 loaded'))).toBe(true)
    expect(lines.filter(line => line.includes('lock debugging'))).toHaveLength(1)
    delete (globalThis as Record<string, unknown>).__events
  })

  it('answers ENOEXEC for a kernel_api mismatch, and -f loads it tainted F', async () => {
    const kmod = manager()
    const source = file(['name=future', 'kernel_api=^9'])
    await expect(kmod.load(source)).rejects.toMatchObject({ code: 'ENOEXEC' })
    const mod = await kmod.load(source, { force: true })
    expect(mod.flags).toContain('F')
  })

  it('refuses a second load of the same name, a module with no init, and an unmet depends', async () => {
    const kmod = manager()
    await kmod.load(file(['name=once']))
    await expect(kmod.load(file(['name=once']))).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(kmod.load(file(['name=noinit'], 'export default {}'))).rejects.toMatchObject({ code: 'ENOEXEC' })
    await expect(kmod.load(file(['name=needy', 'depends=absent']))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(find_module('noinit')).toBeNull()
  })

  it('leaves nothing behind when init throws, including what it exported', async () => {
    const kmod = manager()
    await expect(kmod.load(file(['name=bad'], `export default { init(ctx) { ctx.export('bad.sym', 1); ctx.onExit(() => { globalThis.__undone = true }); throw new Error('boom') } }`))).rejects.toThrow('boom')
    expect(find_module('bad')).toBeNull()
    expect(kmod.symbols()).toEqual([])
    expect((globalThis as Record<string, unknown>).__undone).toBe(true)
    delete (globalThis as Record<string, unknown>).__undone
  })

  it('exports symbols other modules import, which makes the exporter busy until the importer leaves', async () => {
    const kmod = manager()
    await kmod.load(file(['name=lib'], `export default { init(ctx) { ctx.export('lib.add', (a, b) => a + b) } }`))
    expect(kmod.symbols()).toEqual([{ symbol: 'lib.add', module: 'lib' }])
    await kmod.load(file(['name=user'], `export default { init(ctx) { globalThis.__sum = ctx.import('lib.add')(2, 3) } }`))
    expect((globalThis as Record<string, unknown>).__sum).toBe(5)
    await expect(kmod.unload('lib')).rejects.toMatchObject({ code: 'EBUSY' })
    await kmod.unload('user')
    await kmod.unload('lib')
    expect(kmod.symbols()).toEqual([])
    delete (globalThis as Record<string, unknown>).__sum
  })

  it('refuses a symbol that is taken, and an unknown one', async () => {
    const kmod = manager()
    await kmod.load(file(['name=a'], `export default { init(ctx) { ctx.export('s', 1) } }`))
    await expect(kmod.load(file(['name=b'], `export default { init(ctx) { ctx.export('s', 2) } }`))).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(kmod.load(file(['name=c'], `export default { init(ctx) { ctx.import('nope') } }`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('unloads a held module only with force, and the holder lets go', async () => {
    const kmod = manager()
    await kmod.load(file(['name=base']))
    const held = await kmod.load(file(['name=top', 'depends=base']))
    await expect(kmod.unload('base')).rejects.toMatchObject({ code: 'EBUSY' })
    await kmod.unload('base', true)
    expect(find_module('base')).toBeNull()
    expect(held.uses.size).toBe(0)
  })

  it('does nothing once modules_disabled is set', async () => {
    const kmod = manager()
    await kmod.load(file(['name=before']))
    kmod.disable()
    await expect(kmod.load(file(['name=after']))).rejects.toMatchObject({ code: 'EPERM' })
    await expect(kmod.unload('before')).rejects.toMatchObject({ code: 'EPERM' })
    expect(find_module('before')).not.toBeNull()
    expect(new ModuleError('X', 'y').code).toBe('X')
  })
})
