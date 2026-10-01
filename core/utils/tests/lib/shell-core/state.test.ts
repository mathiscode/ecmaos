import { describe, expect, it } from 'vitest'

import { ShellState, isInternalVariable } from '../../../src/lib/shell-core/state.ts'

const make = (vars: Record<string, string> = {}) => new ShellState({ pid: () => 42, ppid: () => 7 }, new Map(Object.entries(vars)))

describe('ShellState variables', () => {
  it('reads what was set, and nothing for an unset name', () => {
    const state = make()
    state.set('x', '1')
    expect(state.lookup('x')).toBe('1')
    expect(state.lookup('nope')).toBeUndefined()
  })

  it('keeps a variable the shell created out of a child environment until export', () => {
    const state = make({ PATH: '/bin' })
    state.set('mine', '1')
    expect(state.environment()).toEqual({ PATH: '/bin' })
    state.markExported('mine')
    expect(state.environment()).toEqual({ PATH: '/bin', mine: '1' })
  })

  it('keeps an inherited variable exported when the shell reassigns it', () => {
    const state = make({ HOME: '/root' })
    state.set('HOME', '/elsewhere')
    expect(state.environment()).toEqual({ HOME: '/elsewhere' })
  })

  it('treats a write made straight into the map as inherited', () => {
    const state = make()
    state.vars.set('FROM_HOST', 'x')
    expect(state.environment()).toEqual({ FROM_HOST: 'x' })
  })

  it('never passes internal names to a child, and forgets the unexported mark on unset', () => {
    const state = make({ '?': '0', '1': 'arg', K: 'v' })
    expect(state.environment()).toEqual({ K: 'v' })
    expect(isInternalVariable('?')).toBe(true)
    expect(isInternalVariable('2')).toBe(true)
    expect(isInternalVariable('K')).toBe(false)
    state.set('tmp', 'x')
    state.unset('tmp')
    state.set('tmp', 'y')
    expect(state.isExported('tmp')).toBe(false)
  })

  it('refuses to assign to or unset a readonly name', () => {
    const state = make()
    state.set('R', '1')
    state.markReadonly('R')
    expect(() => state.set('R', '2')).toThrow(/readonly/)
    expect(() => state.unset('R')).toThrow(/readonly/)
    expect(state.lookup('R')).toBe('1')
  })
})

describe('ShellState integer variables', () => {
  it('evaluates assignments as arithmetic, and += adds', () => {
    const state = make()
    state.setInteger('n', true)
    state.set('n', '3+4')
    expect(state.lookup('n')).toBe('7')
    state.set('n', '5', true)
    expect(state.lookup('n')).toBe('12')
    state.set('n', '')
    expect(state.lookup('n')).toBe('0')
  })

  it('appends text to an ordinary variable and stops converting after +i', () => {
    const state = make()
    state.set('s', 'a')
    state.set('s', 'b', true)
    expect(state.lookup('s')).toBe('ab')
    state.setInteger('s', true)
    state.setInteger('s', false)
    state.set('s', '1+1')
    expect(state.lookup('s')).toBe('1+1')
  })
})

describe('ShellState local scopes', () => {
  it('shadows in a frame and restores on pop', () => {
    const state = make({ x: '0' })
    state.pushLocalScope()
    state.declareLocal('x', '1')
    expect(state.lookup('x')).toBe('1')
    state.popLocalScope()
    expect(state.lookup('x')).toBe('0')
  })

  it('leaves a bare local unset, and a later unset hides the caller value', () => {
    const state = make({ x: '0' })
    state.pushLocalScope()
    state.declareLocal('x')
    expect(state.lookup('x')).toBeUndefined()
    state.set('x', '5')
    state.unset('x')
    expect(state.lookup('x')).toBeUndefined()
    state.popLocalScope()
    expect(state.lookup('x')).toBe('0')
  })

  it('refuses local outside a function', () => {
    expect(() => make().declareLocal('x')).toThrow(/only be used inside a function/)
  })

  it('scopes arrays too, and a bare local hides the caller array', () => {
    const state = make()
    state.setArray('a', ['9'])
    state.pushLocalScope()
    state.declareLocal('a')
    expect(state.lookupArray('a')).toBeUndefined()
    state.setArray('a', ['1', '2'])
    expect([...state.lookupArray('a')!.values()]).toEqual(['1', '2'])
    state.popLocalScope()
    expect([...state.lookupArray('a')!.values()]).toEqual(['9'])
  })

  it('lists variables with frames applied', () => {
    const state = make({ a: '1', b: '2' })
    state.pushLocalScope()
    state.declareLocal('a', 'local')
    state.declareLocal('b')
    expect(Object.fromEntries(state.visibleVariables())).toEqual({ a: 'local' })
  })
})

describe('ShellState arrays', () => {
  it('assigns, appends past the highest index, sets and unsets an element', () => {
    const state = make()
    state.setArray('a', ['p', 'q'])
    state.appendArray('a', ['r'])
    state.setArrayElement('a', 5, 's')
    state.unsetArrayElement('a', 0)
    expect([...state.lookupArray('a')!.entries()]).toEqual([[1, 'q'], [2, 'r'], [5, 's']])
    state.unsetArray('a')
    expect(state.lookupArray('a')).toBeUndefined()
  })
})

describe('ShellState computed parameters', () => {
  it('computes $$, $PPID, $LINENO, $- and an unset $!', () => {
    const state = make()
    expect(state.lookup('$')).toBe('42')
    expect(state.lookup('PPID')).toBe('7')
    state.lineNumber = 9
    expect(state.lookup('LINENO')).toBe('9')
    expect(state.lookup('!')).toBeUndefined()
    state.lastBackgroundPid = 77
    expect(state.lookup('!')).toBe('77')
    state.setOption('errexit', true)
    state.setOption('nounset', true)
    expect(state.lookup('-')).toBe('ehuBi')
  })

  it('seeds RANDOM and restarts SECONDS instead of storing them', () => {
    const state = make()
    state.set('RANDOM', '1')
    const first = state.lookup('RANDOM')
    state.set('RANDOM', '1')
    expect(state.lookup('RANDOM')).toBe(first)
    expect(state.vars.has('RANDOM')).toBe(false)
    state.set('SECONDS', '100')
    expect(Number(state.lookup('SECONDS'))).toBeGreaterThanOrEqual(100)
  })

  it('lets local shadow a computed parameter, but not a plain assignment replace it', () => {
    const state = make()
    state.pushLocalScope()
    state.declareLocal('RANDOM', 'fixed')
    expect(state.lookup('RANDOM')).toBe('fixed')
  })
})

describe('ShellState snapshots', () => {
  it('restores variables, arrays, functions, aliases, traps, options and the exported marks', () => {
    const state = make({ A: '1' })
    state.set('mine', '1')
    state.setArray('arr', ['x'])
    state.aliases.set('ll', 'ls -l')
    state.setTrap('echo bye', 'SIGEXIT')
    const snapshot = state.snapshot()

    state.set('A', '2')
    state.set('added', '3')
    state.markExported('mine')
    state.setArrayElement('arr', 1, 'y')
    state.aliases.clear()
    state.setTrap(undefined, 'EXIT')
    state.setOption('errexit', true)
    state.restore(snapshot)

    expect(state.lookup('A')).toBe('1')
    expect(state.lookup('added')).toBeUndefined()
    expect(state.isExported('mine')).toBe(false)
    expect([...state.lookupArray('arr')!.values()]).toEqual(['x'])
    expect(state.aliases.get('ll')).toBe('ls -l')
    expect(state.getTrap('EXIT')).toBe('echo bye')
    expect(state.options.errexit).toBe(false)
  })
})
