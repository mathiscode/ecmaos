/**
 * Real `execve`'d `install`: fetches a package from an npm-style registry into `/usr/lib` and links
 * its bins into `/usr/bin`. `fetch` and `crypto.subtle` exist in a worker, the filesystem work is
 * plain syscalls, `tar` runs as its own real process (`proc_spawn`/`proc_wait`), and the package's
 * `ecmaos:preinstall`/`ecmaos:postinstall` scripts go through `shell_exec` -- the same full command
 * line entry point `crond` uses -- so they behave exactly as when the old in-process command called
 * `shell.execute`.
 */
import semver from 'semver'

import { join } from './lib/path-utils.mjs'

const { argv, env, exit, write, custom, open, read, close, writeAll, mkdir, rename, symlink, unlink, rmRecursive, access, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

const usage = `Usage: install <package-name>[@version] [--registry URL] [--reinstall]
Install a package from a registry into /usr/lib and link its bins into /usr/bin.

  --registry URL  registry to use (default: $REGISTRY, else https://registry.npmjs.org)
  --reinstall     remove an installed copy first
  --help          display this help and exit`

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const line = (stream, text) => write(stream, encoder.encode(text + '\n'))
const red = text => `\x1b[31m${text}\x1b[0m`
const green = text => `\x1b[32m${text}\x1b[0m`
const blue = text => `\x1b[34m${text}\x1b[0m`

const dirname = path => path.slice(0, path.lastIndexOf('/')) || '/'
const exists = path => { try { access(path); return true } catch { return false } }

function mkdirp(path) {
  if (path === '/' || exists(path)) return
  mkdirp(dirname(path))
  mkdir(path, 0o755)
}

function readText(path) {
  const fd = open(path, O_RDONLY)
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
    }
  } finally {
    close(fd)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return decoder.decode(bytes)
}

function writeBytes(path, bytes) {
  const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
  try {
    writeAll(fd, bytes)
  } finally {
    close(fd)
  }
}


async function runTar(tarballPath, directory) {
  const pid = await custom('proc_spawn', '/bin/tar', JSON.stringify(['tar', '-xzf', tarballPath, '-C', directory]), '')
  return await custom('proc_wait', pid)
}

/** Returns an exit code; 0 for "installed" and for "already installed". */
async function install(packageArg, registryArg, reinstall) {
  const spec = packageArg.match(/(@[^/]+\/[^@]+|[^@]+)(?:@([^/]+))?/)
  if (!spec) {
    line(2, red('Invalid package name format'))
    return 1
  }

  const registry = registryArg || env['REGISTRY'] || 'https://registry.npmjs.org'
  const packageName = spec[1]?.replace('vnpm:', '')
  let version = spec[2] || 'latest'

  if (!packageName) {
    line(2, red('Invalid package name format'))
    return 1
  }

  const data = await (await globalThis.fetch(`${registry}/${packageName}`)).json()
  if (!data.versions || !data['dist-tags']) {
    line(2, red(`No versions found for ${packageName}`))
    return 1
  }

  if (version === 'latest') version = data['dist-tags'].latest
  else version = semver.maxSatisfying(Object.keys(data.versions), version) || version

  if (reinstall) {
    try {
      const pkgData = JSON.parse(readText(join('/usr/lib', packageName, version, 'package.json')))
      for (const bin in pkgData.bin) unlink(join('/usr/bin', bin))
      rmRecursive(join('/usr/lib', packageName, version))
    } catch {
      // nothing installed yet, or already partly removed
    }
  }

  const packagePath = join('/usr/lib', packageName, version, 'package.json')
  if (exists(packagePath)) {
    line(1, green(`${packageName} v${version} is already installed`))
    return 0
  }

  line(1, `Installing ${data.name} v${version} from ${registry}...`)

  const tarballUrl = data.versions[version]?.dist?.tarball
  const tarballChecksum = data.versions[version]?.dist?.shasum?.toLowerCase()
  if (!tarballUrl || !tarballChecksum) {
    line(2, red(`No tarball URL or checksum found for ${packageName} v${version}`))
    return 1
  }

  const arrayBuffer = await (await globalThis.fetch(tarballUrl)).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-1', arrayBuffer)
  const downloadChecksum = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')

  if (downloadChecksum !== tarballChecksum) {
    line(2, red(`Checksum verification failed. Expected ${tarballChecksum} but got ${downloadChecksum}`))
    return 1
  }

  const tarballPath = `/tmp/${data.name.replace('@', '').replace('/', '-')}-${version}.tar.gz`
  writeBytes(tarballPath, new Uint8Array(arrayBuffer))

  // npm tarballs wrap their contents in a `package/` directory, and `tar` has no npm knowledge, so
  // extraction lands in a scratch directory first and whatever is inside becomes the install path.
  // The scratch directory lives under `/usr/lib` (the mount the install path is on), not `/tmp`:
  // `rename` across mounts fails with a real `EXDEV`, as `rename(2)` does on Linux.
  const extractPath = `/usr/lib/${data.name}/${version}`
  const scratchDir = `/usr/lib/.install-${packageName.replace(/[^a-zA-Z0-9._-]/g, '_')}-${version}-${Date.now()}`
  mkdirp(scratchDir)
  const tarExitCode = await runTar(tarballPath, scratchDir)
  unlink(tarballPath)

  if (tarExitCode !== 0) {
    line(2, red(`Failed to extract ${packageName}@${version}`))
    rmRecursive(scratchDir)
    return 1
  }

  const packageDirInScratch = join(scratchDir, 'package')
  const extractedDir = exists(packageDirInScratch) ? packageDirInScratch : scratchDir

  mkdirp(dirname(extractPath))
  rename(extractedDir, extractPath)
  try { rmRecursive(scratchDir) } catch { /* already moved */ }
  line(1, green(`Installed ${data.name} v${version} to ${extractPath}`))

  const packageJson = JSON.parse(readText(packagePath))

  try {
    if (packageJson.scripts?.['ecmaos:preinstall']) await custom('shell_exec', packageJson.scripts['ecmaos:preinstall'])
  } catch (error) {
    line(2, red(`Failed to execute preinstall script for ${packageName}@${version}: ${error}`))
    return 1
  }

  try {
    if (packageJson.bin) {
      const bins = typeof packageJson.bin === 'string' ? { [packageJson.name]: packageJson.bin } : packageJson.bin
      for (const bin in bins) {
        const binPath = join('/usr/lib', packageName, version, bins[bin])
        if (!exists(binPath)) {
          line(2, red(`${binPath} does not exist`))
          return 1
        }
        symlink(binPath, join('/usr/bin', bin))
        line(1, blue(`Linked ${bin} to ${join('/usr/bin', bin)}`))
      }
    }
  } catch (error) {
    line(2, red(`Failed to link bins for ${packageName}@${version}: ${error}`))
  }

  try {
    for (const dependency in packageJson.dependencies ?? {}) {
      const range = packageJson.dependencies[dependency]
      await install(`${dependency}${range ? `@${range}` : ''}`, registryArg, false)
    }
  } catch (error) {
    line(2, red(`Failed to install dependencies for ${packageName}@${version}: ${error}`))
    return 1
  }

  try {
    if (packageJson.scripts?.['ecmaos:postinstall']) await custom('shell_exec', packageJson.scripts['ecmaos:postinstall'])
  } catch (error) {
    line(2, red(`Failed to execute postinstall script for ${packageName}@${version}: ${error}`))
    return 1
  }

  return 0
}

async function main() {
  const args = argv.slice(1)
  if (args.includes('--help') || args.includes('-h')) {
    line(2, usage)
    return 0
  }

  let registry
  let reinstall = false
  let packageArg
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--registry') registry = args[++i]
    else if (arg.startsWith('--registry=')) registry = arg.slice(11)
    else if (arg === '--reinstall') reinstall = true
    else if (!packageArg) packageArg = arg
  }

  if (!packageArg) {
    line(2, red('Usage: install <package-name>[@version]'))
    return 1
  }

  return await install(packageArg, registry, reinstall)
}

try {
  exit(await main())
} catch (error) {
  line(2, `install: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
