/**
 * Fetch a package from an npm-style registry into `/usr/lib` and link its bins into `/usr/bin`.
 * Runs the package's `ecmaos:preinstall`/`ecmaos:postinstall` scripts, if any, as shell commands.
 */
import semver from 'semver'

import { join } from './lib/path-utils.mjs'
import { SHARE_DIRS, linkTree } from './lib/share-links.mjs'

const { argv, env, exit, write, custom, chmod, readdir, open, read, close, writeAll, mkdir, rename, symlink, unlink, rmRecursive, access, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } = globalThis.ecmaosSyscalls

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

function readBytes(path) {
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
  return bytes
}

const readText = path => decoder.decode(readBytes(path))

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

/** Checks `bytes` against the registry's `dist.integrity` (an SRI list; the strongest hash listed decides), else its SHA-1 `shasum` */
async function verify(bytes, dist) {
  const hex = digest => Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  const sri = String(dist?.integrity ?? '').split(/\s+/).map(item => item.match(/^(sha512|sha384|sha256)-(.+)$/)).filter(Boolean)
  const strongest = ['sha512', 'sha384', 'sha256'].map(algorithm => sri.find(item => item[1] === algorithm)).find(Boolean)
  if (strongest) {
    const name = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256' }[strongest[1]]
    const actual = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest(name, bytes))))
    return actual === strongest[2] ? undefined : `Integrity verification failed. Expected ${strongest[1]}-${strongest[2]} but got ${strongest[1]}-${actual}`
  }
  const expected = dist?.shasum?.toLowerCase()
  if (!expected) return 'No integrity or checksum found'
  const actual = hex(await crypto.subtle.digest('SHA-1', bytes))
  return actual === expected ? undefined : `Checksum verification failed. Expected ${expected} but got ${actual}`
}

/** Links a package's bins into `/usr/bin` and its `share/` files into `/usr/share`; an upgrade replaces the links an earlier version left */
function link(packageName, version, packageJson) {
  try {
    if (packageJson.bin) {
      const bins = typeof packageJson.bin === 'string' ? { [packageJson.name]: packageJson.bin } : packageJson.bin
      for (const bin in bins) {
        const binPath = join('/usr/lib', packageName, version, bins[bin])
        if (!exists(binPath)) {
          line(2, red(`${binPath} does not exist`))
          return false
        }
        // a tarball keeps the mode of the file it was packed from, and npm makes a bin executable as it installs it
        chmod(binPath, 0o755)
        // An upgrade replaces the link an earlier version left
        try { unlink(join('/usr/bin', bin)) } catch { /* not linked yet */ }
        symlink(binPath, join('/usr/bin', bin))
        line(1, blue(`Linked ${bin} to ${join('/usr/bin', bin)}`))
      }
    }
  } catch (error) {
    line(2, red(`Failed to link bins for ${packageName}@${version}: ${error}`))
  }

  // `share/applications`, `docs`, `licenses` and `man` are linked where the desktop's launcher, `man` and the rest look
  for (const directory of SHARE_DIRS) {
    try {
      const source = join('/usr/lib', packageName, version, 'share', directory)
      if (exists(source)) for (const linked of linkTree(source, join('/usr/share', directory))) line(1, blue(`Linked ${linked}`))
    } catch (error) {
      line(2, red(`Failed to link share/${directory} for ${packageName}@${version}: ${error}`))
    }
  }
  return true
}

/**
 * A package that ships kernel modules lists them in `package.json` as `"ecmaos": { "modules": ["dist/NAME.ko.mjs"] }` (paths
 * inside the package; `.ko.mjs` or `.ko.wasm`). They are copied into `/lib/modules/RELEASE/` and `depmod` indexes them, so
 * `modprobe NAME` finds them. Returns false if one could not be installed.
 */
async function installModules(packageName, version, packageJson) {
  const listed = packageJson.ecmaos?.modules ?? packageJson.ecmaos?.module ?? []
  const files = (Array.isArray(listed) ? listed : [listed]).filter(file => typeof file === 'string')
  if (!files.length) return true
  try {
    const directory = join('/lib/modules', env['KERNEL_VERSION'])
    for (const file of files) {
      const name = file.slice(file.lastIndexOf('/') + 1)
      const source = join('/usr/lib', packageName, version, file)
      if (!/^[\w.+-]+\.ko\.(mjs|wasm)$/.test(name)) throw new Error(`${file} is not a NAME.ko.mjs or NAME.ko.wasm file`)
      if (!exists(source)) throw new Error(`${source} does not exist`)
      mkdirp(directory)
      writeBytes(join(directory, name), readBytes(source))
      line(1, blue(`Installed module ${name} in ${directory}`))
    }
    const code = await custom('shell_exec', 'depmod')
    if (code) throw new Error(`depmod failed (${code}); run it as root`)
    return true
  } catch (error) {
    line(2, red(`Failed to install the modules of ${packageName}@${version}: ${error instanceof Error ? error.message : error}`))
    return false
  }
}

/**
 * Returns an exit code; 0 for "installed" and for "already installed". A dependency is installed but not linked: its
 * bins and `share/` files are for the package that needs it (as with npm), not for the user's PATH.
 */
async function install(packageArg, registryArg, reinstall, dependency = false) {
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
      for (const bin in pkgData.bin) { try { unlink(join('/usr/bin', bin)) } catch { /* a dependency's bins are not linked */ } }
      rmRecursive(join('/usr/lib', packageName, version))
    } catch {
      // nothing installed yet, or already partly removed
    }
  }

  const packagePath = join('/usr/lib', packageName, version, 'package.json')
  if (exists(packagePath)) {
    line(1, green(`${packageName} v${version} is already installed`))
    // it may have come in as a dependency, which is not linked
    if (!dependency) link(packageName, version, JSON.parse(readText(packagePath)))
    return 0
  }

  line(1, `Installing ${data.name} v${version} from ${registry}...`)

  const tarballUrl = data.versions[version]?.dist?.tarball
  const dist = data.versions[version]?.dist
  if (!tarballUrl || !(dist?.integrity || dist?.shasum)) {
    line(2, red(`No tarball URL or checksum found for ${packageName} v${version}`))
    return 1
  }

  const arrayBuffer = await (await globalThis.fetch(tarballUrl)).arrayBuffer()
  const problem = await verify(arrayBuffer, dist)
  if (problem) {
    line(2, red(problem))
    return 1
  }

  const tarballPath = `/tmp/${data.name.replace('@', '').replace('/', '-')}-${version}.tar.gz`
  writeBytes(tarballPath, new Uint8Array(arrayBuffer))

  // npm tarballs wrap their contents in `package/`, so extraction lands in a scratch directory under `/usr/lib` (the
  // install path's mount, since `rename` across mounts fails with `EXDEV`) and its contents become the install path.
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

  if (!dependency && !link(packageName, version, packageJson)) return 1
  if (!await installModules(packageName, version, packageJson)) return 1

  try {
    for (const name in packageJson.dependencies ?? {}) {
      const range = packageJson.dependencies[name]
      await install(`${name}${range ? `@${range}` : ''}`, registryArg, false, true)
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
