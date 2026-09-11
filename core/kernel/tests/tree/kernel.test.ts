import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemory } from '@zenfs/core'

import { Kernel } from '#kernel.ts'
import { KernelState } from '@ecmaos/types'
import type { KernelDevice } from '@ecmaos/types'
import { DefaultFilesystemOptions } from '#filesystem.ts'

import { TestDomOptions, TestLogOptions } from './fixtures/kernel.fixtures'

describe('Kernel', () => {
  let kernel: Kernel

  beforeAll(() => {
    kernel = new Kernel({
      dom: TestDomOptions,
      log: TestLogOptions,
      filesystem: DefaultFilesystemOptions
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should instantiate', () => {
    expect(kernel).toBeDefined()
  })

  it('should boot', async () => {
    // TODO fix this test
    return true
    await kernel.boot({ silent: true })
    expect(kernel.state).toBe(KernelState.RUNNING)
  })

  it('should have a filesystem', () => {
    expect(kernel.filesystem).toBeDefined()
  })

  it('should attach terminal', () => {
    const container = document.createElement('div')
    kernel.terminal.mount(container)
    expect(container.querySelector('xterm-terminal')).toBeDefined()
  })

  it('should initialize with custom filesystem mounts', () => {
    const customMounts = { '/bin': InMemory, '/custom': InMemory }
    const kernelWithCustomFS = new Kernel({
      dom: { topbar: false },
      filesystem: {
        uid: 0,
        gid: 0,
        addDevices: false,
        mounts: customMounts,
        disableAccessChecks: true,
        onlySyncOnClose: true,
        defaultDirectories: true,
        log: {
          enabled: false
        }
      }
    })

    expect(kernelWithCustomFS.filesystem).toBeDefined()
  })

  it('should initialize with custom log', () => {
    const kernelWithCustomLog = new Kernel({
      dom: { topbar: false },
      log: { silent: true }
    })

    expect(kernelWithCustomLog.log).toBeDefined()
  })

  it('should use options.log.name when provided', () => {
    const kernel2 = new Kernel({
      dom: { topbar: false },
      log: { name: 'custom-name' }
    })

    expect(kernel2.log.name).toBe('custom-name')
  })
})

describe('Kernel device dispatch', async () => {
  let kernel: Kernel
  let cliCalls: string[][] = []

  const testDevice: KernelDevice = {
    pkg: { name: 'test-device', version: '0.0.0' },
    async cli(options) {
      cliCalls.push(options.args)
      return 0
    },
    async getDrivers() {
      return [{ name: 'test-device', init: () => ({ major: 250, minor: 0 }), read: () => 0, write: () => 0 }]
    }
  }

  beforeAll(async () => {
    kernel = new Kernel({
      credentials: { username: 'root', password: 'root' },
      devices: { 'test-device': testDevice },
      dom: TestDomOptions,
      filesystem: DefaultFilesystemOptions
    })
    await kernel.boot()
  })

  it('classifies /dev/<name> as a bin:device header via readFileHeader, not a path special-case', async () => {
    const header = await kernel.readFileHeader('/dev/test-device')
    expect(header).toEqual({ type: 'bin', namespace: 'device', name: 'test-device' })
  })

  it('routes execution of /dev/<name> to the device CLI through the same execute() path as any other command', async () => {
    cliCalls = []
    const exitCode = await kernel.execute({ command: '/dev/test-device', args: ['scan'], shell: kernel.shell })
    expect(exitCode).toBe(0)
    expect(cliCalls).toEqual([['scan']])
  })

  it('does not classify a device node with no CLI as a device command', async () => {
    const header = await kernel.readFileHeader('/dev/null')
    expect(header).not.toEqual(expect.objectContaining({ namespace: 'device' }))
  })
})
