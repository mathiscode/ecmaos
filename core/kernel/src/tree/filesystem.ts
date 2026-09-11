/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Filesystem class provides a virtual filesystem for the ecmaOS kernel.
 * 
 * @see {@link https://github.com/zen-fs/core ZenFS}
 *
 */

import { TFunction } from 'i18next'
import { configure as configureZenFS, fs, InMemory, mounts } from '@zenfs/core'
import { IndexedDB } from '@zenfs/dom'
import { DevTmpFS, ProcFS, SysFS } from '@zenfs/linux'
import { proc_root } from '@zenfs/linux/fs/procfs'
import { TarReader } from '@gera2ld/tarjs'
import pako from 'pako'
import path from 'path'

import type { ConfigMounts, Configuration } from '@zenfs/core'

import type {
  FilesystemConfigMounts,
  FilesystemOptions,
  StorageProvider
} from '@ecmaos/types'

export const DefaultFilesystemOptions: Configuration<ConfigMounts> = {
  uid: 0,
  gid: 0,
  // /dev is DevTmpFS, mounted explicitly below; @zenfs/core's legacy DeviceFS is not used
  addDevices: false,
  defaultDirectories: true,
  disableAccessChecks: false,
  disableAsyncCache: false,
  onlySyncOnClose: false,
  log: {
    level: 'debug',
    enabled: false
  },
  mounts: {
    '/': { backend: IndexedDB, options: { storeName: 'root' } },
    '/dev': new DevTmpFS(),
    '/media': { backend: InMemory, options: { name: 'media' } },
    '/mnt': { backend: InMemory, options: { name: 'mnt' } },
    '/proc': new ProcFS(),
    '/sys': new SysFS(),
    '/tmp': { backend: InMemory, options: { name: 'tmpfs' } }
  },
}

/**
 * @experimental
 * @author Jay Mathis <code@mathis.network> (https://github.com/mathiscode)
 *
 * The Filesystem class provides a virtual filesystem for the ecmaOS kernel.
 * 
 * @see {@link https://github.com/zen-fs/core ZenFS}
 *
 */
export class Filesystem {
  private _config: Configuration<ConfigMounts> = DefaultFilesystemOptions
  private _fs: typeof fs = fs
  private _storage: StorageProvider

  constructor(storage: StorageProvider) {
    this._storage = storage
  }

  /**
   * @returns {FilesystemOptions} The filesystem options.
   */
  get config() { return this._config }

  /**
   * @returns {ZenFS.constants} Constants related to the filesystem.
   */
  get constants() { return this._fs.constants }

  /**
   * @returns The filesystem credentials.
   */
  // get credentials(): Credentials { return credentials }

  /**
   * @returns {DeviceFS} The device filesystem.
   * @remarks Remove or replace this; zenfs.mounts is deprecated.
   */
  // get devfs(): DeviceFS { return this._fs.mounts.get('/dev') as DeviceFS }

  /**
   * @returns {ZenFS.fs.promises} The asynchronous ZenFS filesystem instance.
   */
  get fs() { return this._fs.promises }

  /**
   * @returns {ZenFS.fs} The synchronous ZenFS filesystem instance.
   */
  get fsSync() { return this._fs }

  /**
   * @returns {ZenFS.mounts} The mounted filesystems.
   */
  get mounts(): typeof mounts { return mounts }

  /**
   * Configures the filesystem with the given options.
   * @param {FilesystemOptions} options - The options for the filesystem.
   * @returns {Promise<void>} A promise that resolves when the filesystem is configured.
   */
  async configure(options: Partial<Configuration<ConfigMounts>>) {
    if (!options) return
    this._config = options as Configuration<ConfigMounts>
    await configureZenFS(options)
    this.registerProcEntries()
    const fsInitialized = await this._storage.local.getItem('ecmaos:filesystem:initialized')

    if (import.meta.env['ECMAOS_INITFS'] && !fsInitialized) {
      try {
        const response = await fetch(import.meta.env['ECMAOS_INITFS'])
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
        const arrayBuffer = await response.arrayBuffer()
        // The browser will likely automatically decompress the tarball; either way, extractTarball will handle it
        await this.fs.writeFile('/tmp/initfs.tar', new Uint8Array(arrayBuffer))
        await this.extractTarball('/tmp/initfs.tar', '/')
        await this.fs.unlink('/tmp/initfs.tar')
        await this._storage.local.setItem('ecmaos:filesystem:initialized', 'true')
      } catch (error) {
        globalThis.kernel?.log.error(`Failed to fetch ${import.meta.env['ECMAOS_INITFS']}: ${error}`)
        console.error(error)
      }
    }
  }

  /**
   * Adds ecmaOS's browser-backed entries to ProcFS's `/proc` root.
   *
   * `/proc/version` already exists upstream, generated from the real ZenFS/linux version, and is
   * left alone. `cpuinfo` and `meminfo` are new here, generated on read from `navigator.*` and
   * `performance.memory`. A field that cannot be populated honestly is omitted rather than
   * zero-filled or fabricated.
   */
  private registerProcEntries() {
    proc_root.children.set('cpuinfo', {
      mode: 0o444,
      show: () => {
        const cores = navigator.hardwareConcurrency || 1
        const stanza = (index: number) => [
          `processor\t: ${index}`,
          `vendor_id\t: browser`,
          `model name\t: ${navigator.userAgentData?.platform || navigator.platform || navigator.userAgent}`,
          ''
        ].join('\n')

        return Array.from({ length: cores }, (_, i) => stanza(i)).join('\n')
      }
    })

    proc_root.children.set('meminfo', {
      mode: 0o444,
      show: () => {
        const lines: string[] = []
        if ('deviceMemory' in navigator && navigator.deviceMemory) {
          const totalKb = Math.round(navigator.deviceMemory * 1024 * 1024)
          lines.push(`MemTotal:       ${totalKb} kB`)
        }

        if (performance.memory) {
          const { totalJSHeapSize, usedJSHeapSize, jsHeapSizeLimit } = performance.memory
          lines.push(`MemFree:        ${Math.round((totalJSHeapSize - usedJSHeapSize) / 1024)} kB`)
          lines.push(`MemAvailable:   ${Math.round((jsHeapSizeLimit - usedJSHeapSize) / 1024)} kB`)
        }

        return lines.length ? lines.join('\n') + '\n' : ''
      }
    })
  }

  /**
   * Checks if a file or directory exists at the given path.
   * @param {string} path - The path to check.
   * @returns {Promise<boolean>} A promise that resolves to true if the path exists, false otherwise.
   * 
   * @remarks A shortcut for `kernel.filesystem.fs.exists`
   */
  async exists(path: string) {
    return await this.fs.exists(path)
  }

  /**
   * Recursively copy every file and directory under `source` to `destination`, both already
   * mounted paths within this filesystem (they may be on different backends -- this is plain
   * `@zenfs/core` file I/O, so it works across mount boundaries the same way `cp -r` does).
   *
   * This is the migration primitive for moving a filesystem's contents onto another backend, e.g.
   * an IndexedDB-backed root's contents onto an `opfs`-mounted directory: mount the destination
   * somewhere temporary, `copyTree('/', '/mnt/opfs-migration')`, then repoint `/etc/fstab` at it.
   * There is no automatic root-swap here -- that needs `root=` cmdline parsing, which does not
   * exist until the overhaul's `init` branch adopts `@zenfs/linux`'s `init()`.
   *
   * @returns the number of files copied (directories are not counted)
   */
  async copyTree(source: string, destination: string): Promise<number> {
    const stats = await this.fs.stat(source)
    if (!stats.isDirectory()) {
      // Not `this.fs.copyFile()`: it throws "the 'data' argument must be of type string or an
      // instance of Buffer..." against a mounted (non-root-InMemory) backend in @zenfs/core@2.7.4
      // -- readFile+writeFile is the same work `copyFile` does internally, without the bug.
      // The extra `new Uint8Array(...)` guards against `writeFile`'s `instanceof Uint8Array` check
      // failing across a module-instance boundary (observed under vitest/jsdom) even though the
      // buffer `readFile` returns is structurally a real Buffer.
      const contents = await this.fs.readFile(source)
      await this.fs.writeFile(destination, new Uint8Array(contents))
      return 1
    }

    try {
      await this.fs.mkdir(destination, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    let copied = 0
    for (const entry of await this.fs.readdir(source)) {
      copied += await this.copyTree(path.join(source, entry), path.join(destination, entry))
    }

    return copied
  }

  /**
   * Extracts a tarball to the given path.
   * TODO: Just use the tar coreutil
   * 
   * @param {string} tarballPath - The path to the tarball.
   * @param {string} extractPath - The path to extract the tarball to.
   * @param {number} fileMode - The mode to set for files. Defaults to 0o644.
   * @param {number} directoryMode - The mode to set for directories. Defaults to 0o755.
   * @returns {Promise<void>} A promise that resolves when the tarball is extracted.
   */
  async extractTarball(tarballPath: string, extractPath: string, fileMode: number = 0o644, directoryMode: number = 0o755) {
    const tarball = await this.fs.readFile(tarballPath)
    
    // Check if the file is gzipped by looking at the magic bytes
    const isGzipped = tarball.length >= 2 && tarball[0] === 0x1f && tarball[1] === 0x8b
    
    // Only decompress if the file is actually gzipped
    const tarData = isGzipped ? pako.ungzip(tarball) : tarball
    const tar = await TarReader.load(tarData)

    const hasPackageDir = tar.fileInfos.some(file => file.name.startsWith('package/'))
    const stripPrefix = hasPackageDir ? 'package/' : ''

    // Helper function to ensure a directory exists, removing any file that conflicts
    const ensureDirectory = async (dirPath: string) => {
      const normalizedPath = path.normalize(dirPath)
      
      // Check if path exists and what type it is
      if (await this.fs.exists(normalizedPath)) {
        try {
          const stat = await this.fs.stat(normalizedPath)
          if (stat.isFile()) {
            // A file exists where we need a directory - remove it
            await this.fs.unlink(normalizedPath)
          } else if (stat.isDirectory()) {
            // Directory already exists, nothing to do
            return
          }
        } catch {
          // If stat fails, try to proceed with mkdir anyway
        }
      }
      
      // Create the directory (recursive will create parent dirs if needed)
      try {
        await this.fs.mkdir(normalizedPath, { mode: directoryMode, recursive: true })
      } catch (mkdirError: unknown) {
        // If mkdir fails with ENOTDIR, it means a parent path is a file, not a directory
        // Recursively check and fix parent directories
        const error = mkdirError as { code?: string; message?: string }
        if (error?.code === 'ENOTDIR' || error?.message?.includes('ENOTDIR')) {
          const parent = path.dirname(normalizedPath)
          if (parent !== normalizedPath && parent !== '.' && parent !== '/') {
            // Recursively ensure parent directory exists
            await ensureDirectory(parent)
            // Retry creating the directory
            await this.fs.mkdir(normalizedPath, { mode: directoryMode, recursive: true })
          } else {
            throw mkdirError
          }
        } else {
          throw mkdirError
        }
      }
    }

    for (const file of tar.fileInfos) {
      // Skip GNU tar @LongLink entries (used for paths > 100 characters)
      // These are metadata entries, not actual files
      if (file.name === '@LongLink' || file.name === './@LongLink' || file.name.endsWith('/@LongLink')) continue

      if (hasPackageDir && !file.name.startsWith(stripPrefix)) continue

      const relativePath = hasPackageDir ? file.name.slice(stripPrefix.length) : file.name
      if (!relativePath) continue

      try {
        if (relativePath.endsWith('/')) {
          await ensureDirectory(path.join(extractPath, relativePath))
          continue
        }

        await ensureDirectory(path.join(extractPath, path.dirname(relativePath)))

        const blob = tar.getFileBlob(file.name)
        if (!blob || !(blob instanceof Blob)) {
          // Skip files that can't be extracted (e.g., hard links, symlinks, or empty files)
          continue
        }

        try {
          const binaryData = await blob.arrayBuffer().then(buffer => new Uint8Array(buffer))
          const filePath = path.join(extractPath, relativePath)
          await this.fs.writeFile(filePath, binaryData, { encoding: 'binary', mode: fileMode })
        } catch (extractError) {
          // If we can't extract the file content, skip it rather than failing the entire extraction
          globalThis.kernel?.terminal.writeln(`Failed to extract file ${file.name}: ${extractError instanceof Error ? extractError.message : String(extractError)}`)
          continue
        }
      } catch (error) {
        globalThis.kernel?.terminal.writeln(`Failed to extract file ${file.name}: ${error}`)
      }
    }
  }

  /**
   * Returns the default filesystem options with the given extensions.
   * @param {Partial<FilesystemOptions>} extensions - The extensions to apply to the default options.
   * @returns {FilesystemOptions} The filesystem options with the given extensions.
   *
   */
  static options<T extends FilesystemConfigMounts>(extensions?: Partial<FilesystemOptions<T>>): FilesystemOptions<T> {
    return {
      ...DefaultFilesystemOptions,
      ...(extensions || {})
    } as FilesystemOptions<T>
  }

  // Descriptions for common filesystem entries
  descriptions = (t?: TFunction | ((key: string) => string)) => {
    if (!t) t = (k: string) => { return k }

    return new Map([
      ['/bin', t('User Programs')],
      ['/boot', t('Boot files')],
      ['/dev', t('Device files')],
      ['/etc', t('Configuration files')],
      ['/home', t('User home directories')],
      ['/lib', t('Library files')],
      ['/mnt', t('Temporary mount point')],
      ['/opt', t('Optional applications')],
      ['/proc', t('Process/system information')],
      ['/root', t('Root user home directory')],
      ['/run', t('Runtime data')],
      ['/sbin', t('System programs')],
      ['/sys', t('System files')],
      ['/tmp', t('Temporary files')],
      ['/usr', t('User data')],
      ['/var', t('Variable data')],

      ['/proc/connection', t('Network Connection Data')],
      ['/proc/host', t('Hostname')],
      ['/proc/language', t('Language Information')],
      ['/proc/memory', t('Memory Information')],
      ['/proc/platform', t('Platform Information')],
      ['/proc/querystring', t('Query String')],
      ['/proc/userAgent', t('User Agent')],
      ['/proc/userAgentData', t('User Agent Data')],
      ['/proc/version', t('Kernel Version')],

      ['.bin', t('Binary File')],
      ['.bmp', t('Bitmap Image')],
      ['.c', t('C Source File')],
      ['.cpp', t('C++ Source File')],
      ['.css', t('CSS Stylesheet')],
      ['.csv', t('CSV Data')],
      ['.gif', t('GIF Image')],
      ['.gz', t('GZIP Archive')],
      ['.h', t('C Header File')],
      ['.hpp', t('C++ Header File')],
      ['.html', t('HTML Document')],
      ['.ico', t('Icon Image')],
      ['.java', t('Java Source File')],
      ['.jpg', t('JPEG Image')],
      ['.jpeg', t('JPEG Image')],
      ['.js', t('JavaScript File')],
      ['.json', t('JSON Data')],
      ['.jsonc', t('JSONC Data')],
      ['.jsonl', t('JSONL Data')],
      ['.jsx', t('JSX Source File')],
      ['.log', t('Log File')],
      ['.lua', t('Lua Script')],
      ['.md', t('Markdown Document')],
      ['.pdf', t('PDF Document')],
      ['.php', t('PHP Script')],
      ['.png', t('PNG Image')],
      ['.py', t('Python Script')],
      ['.rb', t('Ruby Script')],
      ['.rs', t('Rust Source File')],
      ['.scala', t('Scala Source File')],
      ['.sh', t('Shell Script')],
      ['.sixel', t('Sixel Graphics')],
      ['.svg', t('SVG Image')],
      ['.swift', t('Swift Source File')],
      ['.tar', t('TAR Archive')],
      ['.tar.bz2', t('TAR Archive (BZIP2)')],
      ['.tar.gz', t('TAR Archive (GZIP)')],
      ['.tar.xz', t('TAR Archive (XZ)')],
      ['.ts', t('TypeScript File')],
      ['.tsx', t('TypeScript React File')],
      ['.txt', t('Text File')],
      ['.vue', t('Vue.js Component')],
      ['.wasm', t('WebAssembly Module')],
      ['.wat', t('WebAssembly Text Format')],
      ['.webm', t('WebM Video')],
      ['.webp', t('WebP Image')],
      ['.xml', t('XML Document')],
      ['.yaml', t('YAML Data')],
      ['.yml', t('YAML Data')],
      ['.zip', t('ZIP Archive')],
    ])
  }
}
