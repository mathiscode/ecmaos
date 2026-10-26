import { beforeAll, describe, expect, it } from 'vitest'

describe('who may write to a terminal', () => {
  const modes: Record<string, number> = { '/dev/xterm0': 0o666, '/dev/xterm1': 0o644, '/dev/xterm2': 0o600, '/dev/xterm3': 0o620 }
  let uid = 1000
  let state: any

  beforeAll(async () => {
    ;(globalThis as any).ecmaosSyscalls = {
      stat: (path: string) => { if (!(path in modes)) throw new Error('ENOENT'); return { mode: 0o20000 | modes[path]! } },
      getuid: () => uid
    }
    // @ts-expect-error plain JS module
    state = await import('../../src/commands-execve/lib/mesg-state.mjs')
  })

  it('names the device of a login line', () => {
    expect(state.deviceOf('tty2')).toBe('/dev/xterm2')
    expect(state.deviceOf('3')).toBe('/dev/xterm3')
  })

  it('takes messages while group or other can write, refuses without, and lets root through', () => {
    expect(state.acceptsMessages('/dev/xterm0')).toBe(true)
    expect(state.acceptsMessages('/dev/xterm3')).toBe(true)
    expect(state.acceptsMessages('/dev/xterm2')).toBe(false)
    expect(state.mayWrite('/dev/xterm2')).toBe(false)
    uid = 0
    expect(state.mayWrite('/dev/xterm2')).toBe(true)
  })

  it('assumes a terminal it cannot examine takes messages', () => {
    expect(state.acceptsMessages('/dev/xterm9')).toBe(true)
  })
})
