import fs from 'node:fs'
import path from 'node:path'

/**
 * Where this machine keeps everything it persists: `$ECMAOS_DATA`, else `./.ecmaos`. The folder holds the root
 * filesystem (`root.db` with its `-wal` and `-shm` files) and the kernel's settings, and nothing is written outside it,
 * so the whole machine can be moved, backed up or deleted as one folder.
 */
export function resolveDataDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = path.resolve(explicit || env['ECMAOS_DATA'] || '.ecmaos')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
