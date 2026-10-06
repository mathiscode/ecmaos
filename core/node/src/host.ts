import os from 'node:os'

import { DefaultFilesystemOptions } from '@ecmaos/kernel/filesystem'
import { InMemory } from '@zenfs/core'
import * as TTYDevice from '@ecmaos-devices/tty'

import type { Host } from '@ecmaos/types'

import { MemoryStorage } from './memory-storage.ts'

/**
 * The Node host. The root filesystem is in memory for now (a persistent one comes with the data directory), the only
 * device is the tty, and there is no page, so no DOM, service worker or notifications.
 */
export function nodeHost(): Host {
  return {
    kind: 'node',
    storage: { local: new MemoryStorage(), session: new MemoryStorage() },
    platform: {
      hostname: () => os.hostname(),
      restart() { throw new Error('restart is not supported yet') }
    },
    defaults: {
      devices: { tty: TTYDevice },
      dom: { topbar: false },
      filesystem: {
        ...DefaultFilesystemOptions,
        mounts: { ...DefaultFilesystemOptions.mounts, '/': { backend: InMemory, options: { name: 'root' } } }
      } as NonNullable<Host['defaults']>['filesystem'],
      programs: false,
      service: { register: false }
    }
  }
}
