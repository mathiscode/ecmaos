/**
 * Real `execve`'d `uninstall` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/kernel/src/tree/lib/commands/index.ts`'s old `createUninstall`/`uninstall.ts`). Unlike
 * `install` (blocked on `kernel.filesystem.extractTarball` plus recursive `shell.execute()` calls for
 * pre/postinstall scripts and dependencies -- a worker can't drive its own parent shell), `uninstall`
 * only ever reads directories, reads/parses one `package.json`, and unlinks/removes real files -- all
 * of it plain filesystem syscalls this interpreter already exposes, no kernel-only state at all.
 */

import { join } from './lib/path-utils.mjs'

const { argv, exit, write, readdir, unlink, rmRecursive, rmdir, access } = globalThis.ecmaosSyscalls

const usage = `Usage: uninstall <package-name>[@version]
Uninstall a package. If no version is specified, all versions will be uninstalled.`

function exists(path) {
  try { access(path); return true } catch { return false }
}

/** Minimal whole-file read -- `read()` never blocks past what's buffered, so read in a loop. */
function readWholeFile(path) {
  const { open, read, close } = globalThis.ecmaosSyscalls
  const fd = open(path, 0 /* O_RDONLY */)
  const chunkSize = 65536
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(chunkSize)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      if (n < chunkSize) break
    }
  } finally {
    close(fd)
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

function main() {
  const args = argv.slice(1)
  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  const packageArg = args[0]
  if (!packageArg) {
    write(2, new TextEncoder().encode('Usage: uninstall <package-name>[@version]\n'))
    return 1
  }

  const spec = packageArg.match(/(@[^/]+\/[^@]+|[^@]+)(?:@([^/]+))?/)
  if (!spec) {
    write(2, new TextEncoder().encode('Invalid package name format\n'))
    return 1
  }

  const packageName = spec[1]?.replace('vnpm:', '')
  const version = spec[2]

  if (!packageName) {
    write(2, new TextEncoder().encode('Invalid package name format\n'))
    return 1
  }

  const packageDir = join('/usr/lib', packageName)

  if (!exists(packageDir)) {
    write(2, new TextEncoder().encode(`Package ${packageName} is not installed\n`))
    return 1
  }

  const versions = readdir(packageDir)

  if (versions.length === 0) {
    write(2, new TextEncoder().encode(`No versions found for ${packageName}\n`))
    return 1
  }

  const versionsToUninstall = version ? versions.filter(v => v === version) : versions

  if (version && versionsToUninstall.length === 0) {
    write(2, new TextEncoder().encode(`Version ${version} of ${packageName} is not installed\n`))
    write(2, new TextEncoder().encode(`Installed versions: ${versions.join(', ')}\n`))
    return 1
  }

  let hasError = false

  for (const versionToUninstall of versionsToUninstall) {
    const versionPath = join(packageDir, versionToUninstall)
    const packagePath = join(versionPath, 'package.json')

    if (!exists(packagePath)) {
      write(1, new TextEncoder().encode(`Warning: package.json not found for ${packageName}@${versionToUninstall}, skipping binary unlinking\n`))
    } else {
      try {
        const packageJson = JSON.parse(readWholeFile(packagePath))

        if (packageJson.bin) {
          const unlinkBin = (name, binPath) => {
            try {
              unlink(binPath)
              write(1, new TextEncoder().encode(`Unlinked ${name} from ${binPath}\n`))
            } catch (error) {
              write(1, new TextEncoder().encode(`Warning: Could not unlink ${binPath}: ${error instanceof Error ? error.message : String(error)}\n`))
            }
          }

          if (typeof packageJson.bin === 'string') {
            unlinkBin(packageJson.name, join('/usr/bin', packageJson.name))
          } else if (typeof packageJson.bin === 'object') {
            for (const bin in packageJson.bin) unlinkBin(bin, join('/usr/bin', bin))
          }
        }
      } catch (error) {
        write(1, new TextEncoder().encode(`Warning: Failed to read package.json for ${packageName}@${versionToUninstall}: ${error instanceof Error ? error.message : String(error)}\n`))
      }
    }

    try {
      rmRecursive(versionPath)
      write(1, new TextEncoder().encode(`Uninstalled ${packageName}@${versionToUninstall}\n`))
    } catch (error) {
      write(2, new TextEncoder().encode(`Failed to remove ${versionPath}: ${error instanceof Error ? error.message : String(error)}\n`))
      hasError = true
    }
  }

  const remainingVersions = (() => { try { return readdir(packageDir) } catch { return [] } })()
  if (remainingVersions.length === 0) {
    try {
      rmdir(packageDir)
    } catch {
      write(1, new TextEncoder().encode(`Warning: Could not remove package directory ${packageDir}\n`))
    }
  }

  return hasError ? 1 : 0
}

try {
  exit(main())
} catch (error) {
  write(2, new TextEncoder().encode(`uninstall: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
