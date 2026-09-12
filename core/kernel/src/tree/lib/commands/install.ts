import chalk from 'chalk'
import path from 'path'
import semver from 'semver'

import { CommandArgs } from './'

const install = async ({ kernel, shell, terminal, args }: CommandArgs) => {
  const [packageArg, registryArg, reinstallArg] = args as [string, string, boolean]
  if (!packageArg) {
    terminal.writeln(chalk.red('Usage: install <package-name>[@version]'))
    return 1
  }

  const spec = packageArg.match(/(@[^/]+\/[^@]+|[^@]+)(?:@([^/]+))?/)
  if (!spec) {
    terminal.writeln(chalk.red('Invalid package name format'))
    return 1
  }

  const registry = registryArg || shell.env.get('REGISTRY') || 'https://registry.npmjs.org'
  const packageName = spec[1]?.replace('vnpm:', '')
  let version = spec[2] || 'latest'

  if (!packageName) {
    terminal.writeln(chalk.red('Invalid package name format'))
    return 1
  }

  const url = `${registry}/${packageName}`
  const packageInfo = await globalThis.fetch(url)
  const data = await packageInfo.json()

  if (!data.versions || !data['dist-tags']) {
    terminal.writeln(chalk.red(`No versions found for ${packageName}`))
    return 1
  }

  if (version === 'latest') version = data['dist-tags'].latest
  else version = semver.maxSatisfying(Object.keys(data.versions), version) || version

  if (reinstallArg) {
    try {
      const pkgData = JSON.parse(await kernel.filesystem.fs.readFile(path.join('/usr/lib', packageName, version, 'package.json'), 'utf-8'))
      for (const bin in pkgData.bin) await kernel.filesystem.fs.unlink(path.join('/usr/bin', bin))
      await kernel.filesystem.fs.rm(path.join('/usr/lib', packageName, version), { recursive: true, force: true })
    } catch {}
  }

  const packagePath = path.join('/usr/lib', packageName, version, 'package.json')
  if (await kernel.filesystem.fs.exists(packagePath)) {
    terminal.writeln(chalk.green(`${packageName} v${version} is already installed`))
    return 0
  }

  terminal.writeln(`Installing ${data.name} v${version} from ${registry}...`)

  const tarballUrl = data.versions[version]?.dist?.tarball
  const tarballChecksum = data.versions[version]?.dist?.shasum?.toLowerCase()
  if (!tarballUrl || !tarballChecksum) {
    terminal.writeln(chalk.red(`No tarball URL or checksum found for ${packageName} v${version}`))
    return 1
  }

  const tarball = await globalThis.fetch(tarballUrl)
  const arrayBuffer = await tarball.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-1', arrayBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const downloadChecksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  if (downloadChecksum !== tarballChecksum) {
    terminal.writeln(chalk.red(`Checksum verification failed. Expected ${tarballChecksum} but got ${downloadChecksum}`))
    return 1
  }

  const tarballFilename = `${data.name.replace('@', '').replace('/', '-')}-${version}.tar.gz`
  const tarballPath = `/tmp/${tarballFilename}`
  await kernel.filesystem.fs.writeFile(tarballPath, new Uint8Array(arrayBuffer))

  // TODO: Support user packages installed to user's home?
  const extractPath = `/usr/lib/${data.name}/${version}`

  // Extract via the real `tar` coreutil (shell.execute, not kernel.filesystem.extractTarball directly)
  // so this doesn't keep a second, kernel-only tar-reading path (`@gera2ld/tarjs` + `pako`) alive just
  // for `install` -- `extractTarball` itself stays put, since it's also used by `Filesystem.init()`'s
  // boot-time initfs extraction, which runs before any `Shell` exists to `execute` against.
  //
  // npm tarballs always wrap their contents in a `package/` directory (real npm behavior) -- `tar`
  // itself has no npm-specific knowledge of that, so extraction lands in a scratch directory first,
  // and whatever's inside (the `package/` dir if present, or the scratch dir's own contents
  // otherwise) is what actually becomes `extractPath`. The scratch directory lives under `/usr/lib`
  // itself (the same mount `extractPath` is under), not `/tmp` -- `rename` across different mounted
  // backends fails with a real `EXDEV`, exactly like real Linux's `rename(2)` never crossing devices.
  const scratchDir = `/usr/lib/.install-${packageName.replace(/[^a-zA-Z0-9._-]/g, '_')}-${version}-${Date.now()}`
  await kernel.filesystem.fs.mkdir(scratchDir, { mode: 0o755, recursive: true })
  const tarExitCode = await shell.execute(`tar -xzf ${tarballPath} -C ${scratchDir}`)
  await kernel.filesystem.fs.unlink(tarballPath)

  if (tarExitCode !== 0) {
    terminal.writeln(chalk.red(`Failed to extract ${packageName}@${version}`))
    await kernel.filesystem.fs.rm(scratchDir, { recursive: true, force: true })
    return 1
  }

  const packageDirInScratch = path.join(scratchDir, 'package')
  const extractedDir = await kernel.filesystem.fs.exists(packageDirInScratch) ? packageDirInScratch : scratchDir

  await kernel.filesystem.fs.mkdir(path.dirname(extractPath), { mode: 0o755, recursive: true })
  await kernel.filesystem.fs.rename(extractedDir, extractPath)
  await kernel.filesystem.fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  terminal.writeln(chalk.green(`Installed ${data.name} v${version} to ${extractPath}`))

  const packageData = await kernel.filesystem.fs.readFile(packagePath, 'utf-8')
  const packageJson = JSON.parse(packageData)

  try { // execute preinstall script
    if (packageJson.scripts?.['ecmaos:preinstall']) await shell.execute(packageJson.scripts['ecmaos:preinstall'])
  } catch (error) {
    terminal.writeln(chalk.red(`Failed to execute preinstall script for ${packageName}@${version}: ${error}`))
    return 1
  }

  try { // link any bins
    if (packageJson.bin) {
      if (typeof packageJson.bin === 'string') {
        const binPath = path.join('/usr/lib', packageName, version, packageJson.bin)
        if (!await kernel.filesystem.fs.exists(binPath)) {
          terminal.writeln(chalk.red(`${binPath} does not exist`))
          return 1
        }

        await kernel.filesystem.fs.symlink(binPath, path.join('/usr/bin', packageJson.name))
        terminal.writeln(chalk.blue(`Linked ${packageJson.name} to ${path.join('/usr/bin', packageJson.name)}`))
      } else if (typeof packageJson.bin === 'object') {
        for (const bin in packageJson.bin) {
          const binPath = path.join('/usr/lib', packageName, version, packageJson.bin[bin])
          if (!await kernel.filesystem.fs.exists(binPath)) {
            terminal.writeln(chalk.red(`${binPath} does not exist`))
            return 1
          }

          await kernel.filesystem.fs.symlink(binPath, path.join('/usr/bin', bin))
          terminal.writeln(chalk.blue(`Linked ${bin} to ${path.join('/usr/bin', bin)}`))
        }
      }
    }
  } catch (error) {
    terminal.writeln(chalk.red(`Failed to link bins for ${packageName}@${version}: ${error}`))
  }

  try { // install dependencies
    if (packageJson.dependencies) {
      for (const dependency in packageJson.dependencies) {
        const packageSpec = `${dependency}${packageJson.dependencies[dependency] ? `@${packageJson.dependencies[dependency]}` : ''}`
        await install({ kernel, shell, terminal, args: [packageSpec, registryArg] })
      }
    }
  } catch (error) {
    terminal.writeln(chalk.red(`Failed to install dependencies for ${packageName}@${version}: ${error}`))
    return 1
  }

  try { // execute postinstall script
    if (packageJson.scripts?.['ecmaos:postinstall']) await shell.execute(packageJson.scripts['ecmaos:postinstall'])
  } catch (error) {
    terminal.writeln(chalk.red(`Failed to execute postinstall script for ${packageName}@${version}: ${error}`))
    return 1
  }
}

export default install
