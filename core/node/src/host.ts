import os from 'node:os'
import path from 'node:path'

import { DefaultFilesystemOptions } from '@ecmaos/kernel/filesystem'
import { InMemory } from '@zenfs/core'
import * as TTYDevice from '@ecmaos-devices/tty'

import type { Host } from '@ecmaos/types'

import { resolveDataDir } from './data.ts'
import { MemoryStorage } from './memory-storage.ts'
import { initfsFile, initfsUrl, ProgramsUrl, sourceFetch } from './sources.ts'
import { SqliteStorage } from './sqlite-storage.ts'
import { openDatabase, sqliteRoot } from './sqlite-store.ts'

import type { Synchronous } from './sqlite-store.ts'

export interface NodeHostOptions {
  /** The data directory; `$ECMAOS_DATA`, else `./.ecmaos` when omitted */
  data?: string
  /** A root that lives in memory and leaves nothing behind (tests, throwaway sessions) */
  ephemeral?: boolean
  /** How hard commits are pushed to disk (`$ECMAOS_SYNCHRONOUS`, default `normal`) */
  synchronous?: Synchronous
  /** Where the bundled files are; defaults to beside this build */
  env?: NodeJS.ProcessEnv
}

export interface NodeHost extends Host {
  /** The folder holding this machine's state; absent for an ephemeral one */
  readonly dataDir?: string
  /** Commits and closes the database; the machine is not usable afterwards */
  close(): void
}

const synchronousFrom = (value: string | undefined): Synchronous | undefined =>
  value === 'off' || value === 'normal' || value === 'full' ? value : undefined

/**
 * The Node host. The root filesystem is one SQLite database in the data directory (or in memory when ephemeral), the
 * only device is the tty, and there is no page, so no DOM, service worker or notifications.
 */
export function nodeHost(options: NodeHostOptions = {}): NodeHost {
  const env = options.env ?? process.env
  const persistent = !options.ephemeral
  const dataDir = persistent ? resolveDataDir(options.data, env) : undefined
  const db = dataDir ? openDatabase(path.join(dataDir, 'root.db'), { synchronous: options.synchronous ?? synchronousFrom(env['ECMAOS_SYNCHRONOUS']) }) : undefined
  const root = db ? sqliteRoot(db) : undefined

  const host: NodeHost = {
    kind: 'node',
    dataDir,
    storage: { local: db ? new SqliteStorage(db) : new MemoryStorage(), session: new MemoryStorage() },
    platform: {
      hostname: () => os.hostname(),
      restart() { throw new Error('restart is not supported yet') }
    },
    fetch: sourceFetch(env, [initfsFile()]),
    defaults: {
      devices: { tty: TTYDevice },
      dom: { topbar: false },
      filesystem: {
        ...DefaultFilesystemOptions,
        mounts: { ...DefaultFilesystemOptions.mounts, '/': root ? root.fs : { backend: InMemory, options: { name: 'root' } } }
      } as NonNullable<Host['defaults']>['filesystem'],
      initfs: options.ephemeral ? false : initfsUrl(),
      programs: options.ephemeral ? false : ProgramsUrl,
      service: { register: false }
    },
    close() {
      root?.store.commit()
      db?.close()
    }
  }
  return host
}
