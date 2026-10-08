import { describe, expect, it } from 'vitest'
import { IndexedDB, InMemory } from '@zenfs/dom'

import { freshMachineName, isMachineStore, machineKey, machineStore, MachineKeyPrefix, parseMachine } from '#lib/machine.ts'
import { rootStoreName, withRootStore } from '#filesystem.ts'

describe('machine names', () => {
  it('no parameter, or root, is the default machine', () => {
    for (const raw of [undefined, null, '', 'root']) expect(parseMachine(raw), String(raw)).toEqual({})
  })

  it('accepts lowercase letters, digits and dashes', () => {
    expect(parseMachine('work')).toEqual({ machine: 'work' })
    expect(parseMachine('a-1')).toEqual({ machine: 'a-1' })
    expect(parseMachine('9lives')).toEqual({ machine: '9lives' })
  })

  it('refuses anything else with a message, so a name can never reach a store or key unchecked', () => {
    for (const bad of ['Work', '-x', 'a b', 'a/b', '../root', 'a.b', 'x'.repeat(33), 'é', 'a:b']) expect(parseMachine(bad).error, bad).toMatch(/not a machine name/)
  })
})

describe('what a machine owns', () => {
  it('has its own store, and the default keeps the one it always had', () => {
    expect(machineStore(undefined)).toBe('zenfs')
    expect(machineStore('work')).toBe('zenfs-work')
    expect(isMachineStore('zenfs') && isMachineStore('zenfs-work')).toBe(true)
    expect(isMachineStore('root')).toBe(false)
    expect(isMachineStore('ecmaos:storage')).toBe(false)
  })

  it('keeps the default machine\'s keys unscoped and scopes the others\'', () => {
    expect(machineKey(undefined, 'ecmaos:first-boot')).toBe('ecmaos:first-boot')
    expect(machineKey('work', 'ecmaos:first-boot')).toBe(`${MachineKeyPrefix}work:ecmaos:first-boot`)
    expect(machineKey('work', 'a')).not.toBe(machineKey('play', 'a'))
  })

  it('suggests a name no store uses', () => {
    expect(freshMachineName([])).toBe('machine-2')
    expect(freshMachineName(['zenfs', 'zenfs-machine-2', 'zenfs-machine-3'])).toBe('machine-4')
  })
})

describe('pointing the root at a machine', () => {
  const indexed = { mounts: { '/': { backend: IndexedDB, storeName: 'zenfs' }, '/tmp': { backend: InMemory, options: { name: 'tmpfs' } } } }

  it('changes only the store name of an IndexedDB root, leaving the original untouched', () => {
    const moved = withRootStore(indexed, 'zenfs-work')
    expect(rootStoreName(moved)).toBe('zenfs-work')
    expect(rootStoreName(indexed)).toBe('zenfs')
    expect(moved.mounts['/tmp']).toBe(indexed.mounts['/tmp'])
  })

  it('leaves a root that is not IndexedDB alone', () => {
    const memory = { mounts: { '/': { backend: InMemory, options: { name: 'x' } } } }
    expect(withRootStore(memory, 'zenfs-work')).toBe(memory)
  })
})
