// TODO: Dropbox and S3 are WIP

import path from 'path'
import chalk from 'chalk'
import { Fetch, InMemory, resolveMountConfig, SingleBuffer } from '@zenfs/core'
import { IndexedDB, WebStorage, WebAccess, /* XML */ } from '@zenfs/dom'
import { Iso, Zip } from '@zenfs/archives'
import { Dropbox, /* S3Bucket, */ GoogleDrive } from '@zenfs/cloud'

import type { Kernel, Shell, Terminal, FstabEntry } from '@ecmaos/types'
import type { CommandContext, CommandIO } from '@ecmaos/types'
import { TerminalCommand } from '../shared/terminal-command.js'

/**
 * Parse a single fstab line
 * @param line - The line to parse
 * @returns Parsed entry or null if line is empty/comment
 */
function parseFstabLine(line: string): FstabEntry | null {
  const trimmed = line.trim()
  
  // Skip empty lines and comments
  if (trimmed === '' || trimmed.startsWith('#')) {
    return null
  }

  // Split by whitespace (space or tab)
  // Format: source target type [options]
  const parts = trimmed.split(/\s+/)
  
  if (parts.length < 3) {
    // Need at least source, target, and type
    return null
  }

  const source = parts[0] || ''
  const target = parts[1] || ''
  const type = parts[2] || ''
  const options = parts.slice(3).join(' ') || undefined

  // Validate required fields
  if (!target || !type) {
    return null
  }

  return {
    source: source || '',
    target,
    type,
    options
  }
}

/**
 * Parse a complete fstab file
 * @param content - The fstab file content
 * @returns Array of parsed fstab entries
 */
function parseFstabFile(content: string): FstabEntry[] {
  const lines = content.split('\n')
  const entries: FstabEntry[] = []

  for (const line of lines) {
    if (!line) continue
    const parsed = parseFstabLine(line)
    if (parsed) {
      entries.push(parsed)
    }
  }

  return entries
}

function printUsage(io: CommandIO): void {
  const usage = `Usage: mount [OPTIONS] [SOURCE] TARGET
       mount [-a|--all]
       mount [-l|--list]

Mount a filesystem.

Options:
  -t, --type TYPE     filesystem type
  -o, --options OPTS  mount options (comma-separated key=value pairs)
  -a, --all           mount all filesystems listed in /etc/fstab
  -l, --list          list all mounted filesystems
  --help              display this help and exit

Filesystem types:
  fetch               mount a remote filesystem via HTTP fetch
  indexeddb           mount an IndexedDB-backed filesystem
  webstorage          mount a WebStorage-backed filesystem (localStorage or sessionStorage)
  webaccess           mount a filesystem using the File System Access API (interactive picker)
  opfs                mount the browser's Origin Private File System (no picker, sandboxed per-origin)
  memory              mount an in-memory filesystem
  singlebuffer        mount a filesystem backed by a single buffer
  zip                 mount a readonly filesystem from a zip archive (requires SOURCE file or URL)
  iso                 mount a readonly filesystem from an ISO image (requires SOURCE file or URL)
  googledrive         mount a Google Drive filesystem (requires apiKey via -o apiKey, optionally clientId for OAuth)

Mount options:
  baseUrl=URL         base URL for fetch operations (fetch type)
  size=BYTES          buffer size in bytes for singlebuffer type (default: 1048576)
  storage=TYPE        storage type for webstorage (localStorage or sessionStorage, default: localStorage)
  apiKey=KEY          Google API key (googledrive type, required)
  clientId=ID         Google OAuth client ID (googledrive type, optional)
  scope=SCOPE         OAuth scope (googledrive type, default: https://www.googleapis.com/auth/drive)
  cacheTTL=SECONDS    cache TTL in seconds for cloud backends (optional)

Examples:
  mount -l                                    list all mounted filesystems
  mount -t memory /mnt/tmp                    mount memory filesystem at /mnt/tmp
  mount -t indexeddb mydb /mnt/db             mount IndexedDB store 'mydb' at /mnt/db
  mount -t webstorage /mnt/storage            mount WebStorage filesystem using localStorage
  mount -t webstorage /mnt/storage -o storage=sessionStorage
  mount -t webaccess /mnt/access              mount File System Access API filesystem
  mount -t opfs /mnt/opfs                     mount the Origin Private File System
  mount -t fetch /api /mnt/api                mount fetch filesystem at /mnt/api
  mount -t fetch /api /mnt/api -o baseUrl=https://example.com
  mount -t singlebuffer /mnt/buf              mount singlebuffer filesystem at /mnt/buf
  mount -t singlebuffer /mnt/buf -o size=2097152
  mount -t zip https://example.com/archive.zip /mnt/zip
  mount -t zip /tmp/archive.zip /mnt/zip
  mount -t iso https://example.com/image.iso /mnt/iso
  mount -t iso /tmp/image.iso /mnt/iso
  mount -t googledrive /mnt/gdrive -o apiKey=YOUR_API_KEY # readonly/public
  mount -t googledrive /mnt/gdrive -o clientId=YOUR_CLIENT_ID # rw/private`
  io.writelnErr(usage)
}

export function createCommand(kernel: Kernel, shell: Shell, terminal: Terminal): TerminalCommand {
  return new TerminalCommand({
    command: 'mount',
    description: 'Mount a filesystem',
    kernel,
    shell,
    terminal,
    run: async (ctx: CommandContext, io: CommandIO) => {

      if (ctx.argv.length > 0 && (ctx.argv[0] === '--help' || ctx.argv[0] === '-h')) {
        printUsage(io)
        return 0
      }

      let listMode = false
      let allMode = false
      let type: string | undefined
      let options: string | undefined
      const positionalArgs: string[] = []

      for (let i = 0; i < ctx.argv.length; i++) {
        const arg = ctx.argv[i]
        if (arg === '-l' || arg === '--list') {
          listMode = true
        } else if (arg === '-a' || arg === '--all') {
          allMode = true
        } else if (arg === '-t' || arg === '--type') {
          if (i + 1 < ctx.argv.length) {
            type = ctx.argv[i + 1]
            i++
          } else {
            await io.writelnErr(chalk.red('mount: option requires an argument -- \'t\''))
            return 1
          }
        } else if (arg === '-o' || arg === '--options') {
          if (i + 1 < ctx.argv.length) {
            options = ctx.argv[i + 1]
            i++
          } else {
            await io.writelnErr(chalk.red('mount: option requires an argument -- \'o\''))
            return 1
          }
        } else if (arg && !arg.startsWith('-')) {
          positionalArgs.push(arg)
        }
      }

      if (listMode || (ctx.argv.length === 0 && !allMode)) {
        const mountList = Array.from(kernel.filesystem.mounts.entries())
        
        if (mountList.length === 0) {
          await io.writeln('No filesystems mounted.')
          return 0
        }

        const mountRows = mountList.map(([target, mount]: [string, unknown]) => {
          const mountObj = mount as { store?: { constructor?: { name?: string } }; constructor?: { name?: string }; metadata?: () => { name?: string } }
          const store = mountObj.store
          const backendName = store?.constructor?.name || mountObj.constructor?.name || 'Unknown'
          const metadata = mountObj.metadata?.()
          const name = metadata?.name || backendName
          
          return {
            target: chalk.blue(target),
            name: chalk.gray(name)
          }
        })
        
        for (const row of mountRows) {
          await io.writeln(`${row.target.padEnd(30)} ${row.name}`)
        }

        return 0
      }

      if (allMode) {
        try {
          const fstabPath = '/etc/fstab'
          if (!(await shell.context.fs.promises.exists(fstabPath))) {
            await io.writelnErr(chalk.yellow(`mount: ${fstabPath} not found`))
            return 1
          }

          const content = await shell.context.fs.promises.readFile(fstabPath, 'utf-8')
          const entries = parseFstabFile(content)
          
          if (entries.length === 0) {
            await io.writeln('No entries found in /etc/fstab')
            return 0
          }

          await io.writeln(`Mounting ${entries.length} filesystem(s) from /etc/fstab...`)
          
          let successCount = 0
          let failCount = 0

          for (const entry of entries) {
            try {
              const entryType = entry.type
              const entrySource = entry.source || ''
              const entryTarget = path.resolve('/', entry.target)
              const entryOptions = entry.options

              // Validate entry
              if (!entryType) {
                await io.writelnErr(chalk.yellow(`mount: skipping entry for ${entryTarget}: missing type`))
                failCount++
                continue
              }

              if (!entryTarget) {
                await io.writelnErr(chalk.yellow(`mount: skipping entry: missing target`))
                failCount++
                continue
              }

              // Check if filesystem type doesn't require source but one is provided
              const noSourceTypes = ['memory', 'singlebuffer', 'webstorage', 'webaccess', 'opfs', 'xml', 'dropbox', 'googledrive']
              if (entrySource && noSourceTypes.includes(entryType.toLowerCase())) {
                await io.writelnErr(chalk.yellow(`mount: ${entryType} filesystem does not require a source, ignoring source for ${entryTarget}`))
              }

              // Check if filesystem type requires source but none is provided
              const requiresSourceTypes = ['zip', 'iso', 'fetch', 'indexeddb']
              if (!entrySource && requiresSourceTypes.includes(entryType.toLowerCase())) {
                await io.writelnErr(chalk.yellow(`mount: skipping ${entryTarget}: ${entryType} filesystem requires a source`))
                failCount++
                continue
              }

              // Create target directory if needed
              const parentDir = path.dirname(entryTarget)
              if (parentDir !== entryTarget && !(await shell.context.fs.promises.exists(parentDir))) {
                await shell.context.fs.promises.mkdir(parentDir, { recursive: true })
              }

              if (!(await shell.context.fs.promises.exists(entryTarget))) {
                await shell.context.fs.promises.mkdir(entryTarget, { recursive: true })
              }

              // Parse mount options
              const mountOptions = entryOptions?.split(',').reduce((acc, option) => {
                const [key, value] = option.split('=')
                if (key && value) {
                  acc[key.trim()] = value.trim()
                }
                return acc
              }, {} as Record<string, string>) || {}

              // Perform the mount based on type
              switch (entryType.toLowerCase()) {
                case 'fetch': {
                  let fetchBaseUrl = mountOptions.baseUrl || ''
                  let indexUrl: string

                  if (entrySource && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entrySource)) {
                    indexUrl = entrySource
                  } else {
                    if (!fetchBaseUrl) {
                      throw new Error('fetch filesystem requires either a full URL as source or baseUrl option')
                    }
                    fetchBaseUrl = new URL(fetchBaseUrl).toString()
                    indexUrl = new URL(entrySource || 'index.json', fetchBaseUrl).toString()
                  }
                  
                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: Fetch,
                      index: indexUrl,
                      baseUrl: fetchBaseUrl,
                      disableAsyncCache: true,
                    })
                  )
                  break
                }
                case 'indexeddb':
                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: IndexedDB,
                      storeName: entrySource || entryTarget
                    })
                  )
                  break
                case 'webstorage': {
                  const storageType = mountOptions.storage?.toLowerCase() || 'localstorage'
                  let storage: Storage
                  
                  if (storageType === 'sessionstorage') {
                    if (typeof sessionStorage === 'undefined') {
                      throw new Error('sessionStorage is not available in this environment')
                    }
                    storage = sessionStorage
                  } else if (storageType === 'localstorage') {
                    if (typeof localStorage === 'undefined') {
                      throw new Error('localStorage is not available in this environment')
                    }
                    storage = localStorage
                  } else {
                    throw new Error(`invalid storage type '${storageType}'. Use 'localStorage' or 'sessionStorage'`)
                  }
                  
                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: WebStorage,
                      storage
                    } as { backend: typeof WebStorage; storage: Storage })
                  )
                  break
                }
                case 'webaccess': {
                  if (typeof window === 'undefined') {
                    throw new Error('File System Access API is not available in this environment')
                  }
                  
                  const win = window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
                  if (!win.showDirectoryPicker) {
                    throw new Error('File System Access API is not available in this environment')
                  }
                  
                  // For fstab, we can't interactively pick a directory, so skip
                  await io.writelnErr(chalk.yellow(`mount: skipping ${entryTarget}: webaccess requires interactive directory selection`))
                  failCount++
                  continue
                }
                case 'opfs': {
                  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
                    throw new Error('Origin Private File System is not available in this environment')
                  }

                  const opfsRoot = await navigator.storage.getDirectory()

                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: WebAccess,
                      handle: opfsRoot
                    } as { backend: typeof WebAccess; handle: FileSystemDirectoryHandle })
                  )
                  break
                }
                case 'memory':
                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: InMemory
                    })
                  )
                  break
                case 'singlebuffer': {
                  const bufferSize = mountOptions.size 
                    ? parseInt(mountOptions.size, 10) 
                    : 1048576
                  
                  if (isNaN(bufferSize) || bufferSize <= 0) {
                    throw new Error('invalid buffer size for singlebuffer type')
                  }

                  let buffer: ArrayBuffer | SharedArrayBuffer
                  try {
                    buffer = new SharedArrayBuffer(bufferSize)
                  } catch {
                    buffer = new ArrayBuffer(bufferSize)
                  }

                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: SingleBuffer,
                      buffer
                    })
                  )
                  break
                }
                case 'zip': {
                  if (!entrySource) {
                    throw new Error('zip filesystem requires a source file or URL')
                  }

                  let arrayBuffer: ArrayBuffer

                  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entrySource)) {
                    const response = await fetch(entrySource)
                    if (!response.ok) {
                      throw new Error(`failed to fetch archive: ${response.status} ${response.statusText}`)
                    }
                    arrayBuffer = await response.arrayBuffer()
                  } else {
                    const sourcePath = path.resolve('/', entrySource)
                    if (!(await shell.context.fs.promises.exists(sourcePath))) {
                      throw new Error(`archive file not found: ${sourcePath}`)
                    }
                    const fileData = await shell.context.fs.promises.readFile(sourcePath)
                    arrayBuffer = new Uint8Array(fileData).buffer
                  }

                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: Zip,
                      data: arrayBuffer
                    })
                  )
                  break
                }
                case 'iso': {
                  if (!entrySource) {
                    throw new Error('iso filesystem requires a source file or URL')
                  }

                  let uint8Array: Uint8Array

                  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entrySource)) {
                    const response = await fetch(entrySource)
                    if (!response.ok) {
                      throw new Error(`failed to fetch ISO image: ${response.status} ${response.statusText}`)
                    }
                    const arrayBuffer = await response.arrayBuffer()
                    uint8Array = new Uint8Array(arrayBuffer)
                  } else {
                    const sourcePath = path.resolve('/', entrySource)
                    if (!(await shell.context.fs.promises.exists(sourcePath))) {
                      throw new Error(`ISO image file not found: ${sourcePath}`)
                    }
                    uint8Array = await shell.context.fs.promises.readFile(sourcePath)
                  }

                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: Iso,
                      data: uint8Array
                    })
                  )
                  break
                }
                case 'dropbox': {
                  if (!mountOptions.client) {
                    throw new Error('dropbox filesystem requires client configuration')
                  }

                  let clientConfig: { accessToken: string; [key: string]: unknown }
                  try {
                    clientConfig = JSON.parse(mountOptions.client)
                  } catch {
                    throw new Error('invalid JSON in client option')
                  }

                  if (!clientConfig.accessToken) {
                    throw new Error('client configuration must include accessToken')
                  }

                  const dropboxModule = await import('dropbox')
                  const DropboxClient = dropboxModule.Dropbox
                  const client = new DropboxClient(clientConfig)
                  const cacheTTL = mountOptions.cacheTTL ? parseInt(mountOptions.cacheTTL, 10) : undefined

                  await kernel.filesystem.fsSync.mount(
                    entryTarget,
                    await resolveMountConfig({
                      backend: Dropbox,
                      client,
                      ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {})
                    })
                  )
                  break
                }
                case 'googledrive': {
                  if (typeof window === 'undefined') {
                    throw new Error('Google Drive API requires a browser environment')
                  }

                  if (!mountOptions.apiKey) {
                    throw new Error('googledrive filesystem requires apiKey option')
                  }

                  // Google Drive mounting is complex and requires interactive auth
                  // For fstab, we'll skip it with a warning
                  await io.writelnErr(chalk.yellow(`mount: skipping ${entryTarget}: googledrive requires interactive authentication`))
                  failCount++
                  continue
                }
                default:
                  throw new Error(`unknown filesystem type '${entryType}'`)
              }

              const successMessage = entrySource
                ? chalk.green(`Mounted ${entryType} filesystem from ${entrySource} to ${entryTarget}`)
                : chalk.green(`Mounted ${entryType} filesystem at ${entryTarget}`)
              await io.writeln(successMessage)
              successCount++
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error'
              await io.writelnErr(chalk.red(`mount: failed to mount ${entry.target}: ${errorMessage}`))
              failCount++
            }
          }

          await io.writeln(`\nMount summary: ${successCount} succeeded, ${failCount} failed`)
          return failCount > 0 ? 1 : 0
        } catch (error) {
          await io.writelnErr(chalk.red(`mount: failed to process /etc/fstab: ${error instanceof Error ? error.message : 'Unknown error'}`))
          return 1
        }
      }

      if (positionalArgs.length === 0) {
        await io.writelnErr(chalk.red('mount: missing target argument'))
        await io.writelnErr('Try \'mount --help\' for more information.')
        return 1
      }

      if (positionalArgs.length > 2) {
        await io.writelnErr(chalk.red('mount: too many arguments'))
        await io.writelnErr('Try \'mount --help\' for more information.')
        return 1
      }

      if (!type) {
        await io.writelnErr(chalk.red('mount: filesystem type must be specified'))
        await io.writelnErr('Try \'mount --help\' for more information.')
        return 1
      }

      const source = positionalArgs.length === 2 ? positionalArgs[0] : ''
      const targetArg = positionalArgs[positionalArgs.length - 1]
      
      if (!targetArg) {
        await io.writelnErr(chalk.red('mount: missing target argument'))
        return 1
      }

      const target = path.resolve(shell.cwd, targetArg)

      if (positionalArgs.length === 2 && (type.toLowerCase() === 'memory' || type.toLowerCase() === 'singlebuffer' || type.toLowerCase() === 'webstorage' || type.toLowerCase() === 'webaccess' || type.toLowerCase() === 'opfs' || type.toLowerCase() === 'xml' || type.toLowerCase() === 'dropbox' /* || type.toLowerCase() === 's3' */ || type.toLowerCase() === 'googledrive')) {
        await io.writelnErr(chalk.yellow(`mount: ${type.toLowerCase()} filesystem does not require a source`))
        await io.writelnErr(`Usage: mount -t ${type.toLowerCase()} TARGET`)
        return 1
      }

      if (positionalArgs.length === 1 && (type.toLowerCase() === 'zip' || type.toLowerCase() === 'iso')) {
        await io.writelnErr(chalk.red(`mount: ${type.toLowerCase()} filesystem requires a source file or URL`))
        await io.writelnErr(`Usage: mount -t ${type.toLowerCase()} SOURCE TARGET`)
        return 1
      }

      try {
        const parentDir = path.dirname(target)
        if (parentDir !== target && !(await shell.context.fs.promises.exists(parentDir))) {
          await shell.context.fs.promises.mkdir(parentDir, { recursive: true })
        }

        if (!(await shell.context.fs.promises.exists(target))) {
          await shell.context.fs.promises.mkdir(target, { recursive: true })
        }

        const mountOptions = options?.split(',').reduce((acc, option) => {
          const [key, value] = option.split('=')
          if (key && value) {
            acc[key.trim()] = value.trim()
          }
          return acc
        }, {} as Record<string, string>) || {}

        switch (type.toLowerCase()) {
          case 'fetch': {
            let fetchBaseUrl = new URL(mountOptions.baseUrl || '').toString()
            let indexUrl: string

            if (source && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) {
              indexUrl = source
            } else {
              indexUrl = new URL(source || 'index.json', fetchBaseUrl).toString()
            }
            
            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: Fetch,
                index: indexUrl,
                baseUrl: fetchBaseUrl,
                disableAsyncCache: true,
              })
            )
            break
          }
          case 'indexeddb':
            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: IndexedDB,
                storeName: source || target
              })
            )
            break
          case 'webstorage': {
            const storageType = mountOptions.storage?.toLowerCase() || 'localstorage'
            let storage: Storage
            
            if (storageType === 'sessionstorage') {
              if (typeof sessionStorage === 'undefined') {
                await io.writelnErr(chalk.red('mount: sessionStorage is not available in this environment'))
                return 1
              }
              storage = sessionStorage
            } else if (storageType === 'localstorage') {
              if (typeof localStorage === 'undefined') {
                await io.writelnErr(chalk.red('mount: localStorage is not available in this environment'))
                return 1
              }
              storage = localStorage
            } else {
              await io.writelnErr(chalk.red(`mount: invalid storage type '${storageType}'. Use 'localStorage' or 'sessionStorage'`))
              return 1
            }
            
            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: WebStorage,
                storage
              } as { backend: typeof WebStorage; storage: Storage })
            )
            break
          }
          case 'webaccess': {
            if (typeof window === 'undefined') {
              await io.writelnErr(chalk.red('mount: File System Access API is not available in this environment'))
              return 1
            }
            
            const win = window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
            if (!win.showDirectoryPicker) {
              await io.writelnErr(chalk.red('mount: File System Access API is not available in this environment'))
              return 1
            }
            
            try {
              const directoryHandle = await win.showDirectoryPicker()
              
              await kernel.filesystem.fsSync.mount(
                target,
                await resolveMountConfig({
                  backend: WebAccess,
                  handle: directoryHandle
                } as { backend: typeof WebAccess; handle: FileSystemDirectoryHandle })
              )
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') {
                await io.writelnErr(chalk.yellow('mount: directory selection cancelled'))
                return 1
              }
              throw error
            }
            break
          }
          case 'opfs': {
            if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
              await io.writelnErr(chalk.red('mount: Origin Private File System is not available in this environment'))
              return 1
            }

            const opfsRoot = await navigator.storage.getDirectory()

            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: WebAccess,
                handle: opfsRoot
              } as { backend: typeof WebAccess; handle: FileSystemDirectoryHandle })
            )
            break
          }
          // TODO: Some more work needs to be done with the XML backend
          // case 'xml': {
          //   if (typeof document === 'undefined') {
          //     await io.writelnErr(chalk.red('mount: XML backend requires DOM APIs (document) which are not available in this environment'))
          //     return 1
          //   }
            
          //   let root: Element | undefined
            
          //   if (mountOptions.root) {
          //     const rootSelector = mountOptions.root
          //     const element = document.querySelector(rootSelector)
          //     if (!element) {
          //       await io.writelnErr(chalk.yellow(`mount: root element '${rootSelector}' not found, creating new element`))
          //       root = new DOMParser().parseFromString('<fs></fs>', 'application/xml').documentElement
          //       root.setAttribute('id', 'xmlfs-' + Math.random().toString(36).substring(2, 15))
          //       root.setAttribute('style', 'display: none')
          //     } else {
          //       root = element as Element
          //     }
          //   } else {
          //     root = new DOMParser().parseFromString('<fs></fs>', 'application/xml').documentElement
          //     root.setAttribute('id', 'xmlfs-' + Math.random().toString(36).substring(2, 15))
          //     root.setAttribute('style', 'display: none')
          //   }
            
          //   if (!root) throw new Error('Failed to create root element')

          //   const rootNode = document.createElement('file')
          //   rootNode.setAttribute('paths', JSON.stringify(['/']))
          //   rootNode.setAttribute('nlink', '1')
          //   rootNode.setAttribute('mode', (constants.S_IFDIR | 0o777).toString(16))
          //   rootNode.setAttribute('uid', (0).toString(16))
          //   rootNode.setAttribute('gid', (0).toString(16))
          //   rootNode.textContent = '[]'

          //   root.appendChild(rootNode)
            
          //   try {
          //     const config = {
          //       backend: XML,
          //       root
          //     } as { backend: typeof XML; root: Element }
              
          //     document.body.appendChild(root)
          //     const mountConfig = await resolveMountConfig(config)
          //     await kernel.filesystem.fsSync.mount(target, mountConfig)
          //   } catch (error) {
          //     const errorMessage = error instanceof Error ? error.message : String(error)
          //     await io.writelnErr(chalk.red(`mount: failed to mount XML filesystem: ${errorMessage}`))
          //     if (error instanceof Error && error.stack) {
          //       await io.writelnErr(chalk.gray(`Stack: ${error.stack}`))
          //     }
          //     return 1
          //   }
          //   break
          // }
          case 'memory':
            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: InMemory
              })
            )
            break
          case 'singlebuffer': {
            const bufferSize = mountOptions.size 
              ? parseInt(mountOptions.size, 10) 
              : 1048576
            
            if (isNaN(bufferSize) || bufferSize <= 0) {
              await io.writelnErr(chalk.red('mount: invalid buffer size for singlebuffer type'))
              return 1
            }

            let buffer: ArrayBuffer | SharedArrayBuffer
            try {
              buffer = new SharedArrayBuffer(bufferSize)
            } catch {
              buffer = new ArrayBuffer(bufferSize)
            }

            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: SingleBuffer,
                buffer
              })
            )
            break
          }
          case 'zip': {
            if (!source) {
              await io.writelnErr(chalk.red('mount: zip filesystem requires a source file or URL'))
              return 1
            }

            let arrayBuffer: ArrayBuffer

            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) {
              await io.writeln(chalk.gray(`Fetching archive from ${source}...`))
              const response = await fetch(source)
              if (!response.ok) {
                await io.writelnErr(chalk.red(`mount: failed to fetch archive: ${response.status} ${response.statusText}`))
                return 1
              }
              arrayBuffer = await response.arrayBuffer()
            } else {
              const sourcePath = path.resolve(shell.cwd, source)
              if (!(await shell.context.fs.promises.exists(sourcePath))) {
                await io.writelnErr(chalk.red(`mount: archive file not found: ${sourcePath}`))
                return 1
              }
              await io.writeln(chalk.gray(`Reading archive from ${sourcePath}...`))
              const fileData = await shell.context.fs.promises.readFile(sourcePath)
              arrayBuffer = new Uint8Array(fileData).buffer
            }

            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: Zip,
                data: arrayBuffer
              })
            )
            break
          }
          case 'iso': {
            if (!source) {
              await io.writelnErr(chalk.red('mount: iso filesystem requires a source file or URL'))
              return 1
            }

            let uint8Array: Uint8Array

            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) {
              await io.writeln(chalk.gray(`Fetching ISO image from ${source}...`))
              const response = await fetch(source)
              if (!response.ok) {
                await io.writelnErr(chalk.red(`mount: failed to fetch ISO image: ${response.status} ${response.statusText}`))
                return 1
              }
              const arrayBuffer = await response.arrayBuffer()
              uint8Array = new Uint8Array(arrayBuffer)
            } else {
              const sourcePath = path.resolve(shell.cwd, source)
              if (!(await shell.context.fs.promises.exists(sourcePath))) {
                await io.writelnErr(chalk.red(`mount: ISO image file not found: ${sourcePath}`))
                return 1
              }
              await io.writeln(chalk.gray(`Reading ISO image from ${sourcePath}...`))
              uint8Array = await shell.context.fs.promises.readFile(sourcePath)
            }

            await kernel.filesystem.fsSync.mount(
              target,
              await resolveMountConfig({
                backend: Iso,
                data: uint8Array
              })
            )
            break
          }
          case 'dropbox': {
            if (!mountOptions.client) {
              await io.writelnErr(chalk.red('mount: dropbox filesystem requires client configuration'))
              await io.writelnErr('Usage: mount -t dropbox TARGET -o client=\'{"accessToken":"..."}\'')
              return 1
            }

            try {
              let clientConfig: { accessToken: string; [key: string]: unknown }
              try {
                clientConfig = JSON.parse(mountOptions.client)
              } catch {
                await io.writelnErr(chalk.red('mount: invalid JSON in client option'))
                return 1
              }

              if (!clientConfig.accessToken) {
                await io.writelnErr(chalk.red('mount: client configuration must include accessToken'))
                return 1
              }

              const dropboxModule = await import('dropbox')
              const DropboxClient = dropboxModule.Dropbox
              const client = new DropboxClient(clientConfig)
              const cacheTTL = mountOptions.cacheTTL ? parseInt(mountOptions.cacheTTL, 10) : undefined

              await kernel.filesystem.fsSync.mount(
                target,
                await resolveMountConfig({
                  backend: Dropbox,
                  client,
                  ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {})
                })
              )
            } catch (error) {
              await io.writelnErr(chalk.red(`mount: failed to mount dropbox filesystem: ${error instanceof Error ? error.message : 'Unknown error'}`))
              return 1
            }
            break
          }
          /* case 's3': {
            if (!mountOptions.bucket) {
              await io.writelnErr(chalk.red('mount: s3 filesystem requires bucket option'))
              await io.writelnErr('Usage: mount -t s3 TARGET -o bucket=my-bucket')
              return 1
            }

            try {
              // Start with default config
              let clientConfigRaw: { region?: string; credentials?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }; [key: string]: unknown } = {}

              // Parse client config if provided
              if (mountOptions.client) {
                try {
                  clientConfigRaw = JSON.parse(mountOptions.client)
                } catch {
                  await io.writelnErr(chalk.red('mount: invalid JSON in client option'))
                  return 1
                }
              }

              // Set region: use from config, then env var, then default
              if (!clientConfigRaw.region) {
                clientConfigRaw.region = shell.env.get('AWS_DEFAULT_REGION') || 'us-east-1'
              }

              // Use environment variables as defaults if credentials not provided
              if (!clientConfigRaw.credentials) {
                const accessKeyId = shell.env.get('AWS_ACCESS_KEY_ID')
                const secretAccessKey = shell.env.get('AWS_SECRET_ACCESS_KEY')
                const sessionToken = shell.env.get('AWS_SESSION_TOKEN')

                if (accessKeyId && secretAccessKey) {
                  clientConfigRaw.credentials = {
                    accessKeyId,
                    secretAccessKey,
                    ...(sessionToken ? { sessionToken } : {})
                  }
                }
              } else {
                // Validate credentials if provided
                if (!clientConfigRaw.credentials.accessKeyId || !clientConfigRaw.credentials.secretAccessKey) {
                  await io.writelnErr(chalk.yellow('mount: credentials object should include both accessKeyId and secretAccessKey'))
                  await io.writelnErr('Note: If credentials are not provided, AWS SDK will use default credential chain (env vars, IAM role, etc.)')
                }
              }

              // Configure for browser environment if needed
              if (typeof window !== 'undefined') {
                // Ensure we're using fetch for browser requests
                if (!clientConfigRaw.requestHandler) {
                  // The AWS SDK v3 uses fetch by default in browsers, but we can explicitly set it
                  // This helps ensure CORS is handled properly
                  clientConfigRaw.requestHandler = undefined // Let SDK use default browser fetch
                }
              }

              const s3Module = await import('@aws-sdk/client-s3')
              const S3Client = s3Module.S3
              const client = new S3Client(clientConfigRaw as never)
              const bucketName = mountOptions.bucket
              const prefix = mountOptions.prefix
              const cacheTTL = mountOptions.cacheTTL ? parseInt(mountOptions.cacheTTL, 10) : undefined

              try {
                await kernel.filesystem.fsSync.mount(
                  target,
                  await resolveMountConfig({
                    backend: S3Bucket,
                    client,
                    bucketName,
                    ...(prefix ? { prefix } : {}),
                    ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {})
                  })
                )
              } catch (mountError) {
                const errorMessage = mountError instanceof Error ? mountError.message : String(mountError)
                // Provide helpful guidance for common S3 errors
                await io.writelnErr(chalk.red(`mount: failed to mount s3 filesystem: ${errorMessage}`))
                await io.writelnErr(chalk.yellow('\nS3 CORS configuration may be required:'))
                await io.writelnErr('For browser access, your S3 bucket needs CORS configuration:')
                await io.writelnErr('  {')
                await io.writelnErr('    "CORSRules": [{')
                await io.writelnErr('      "AllowedOrigins": ["*"],')
                await io.writelnErr('      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],')
                await io.writelnErr('      "AllowedHeaders": ["*"],')
                await io.writelnErr('      "ExposeHeaders": ["ETag"],')
                await io.writelnErr('      "MaxAgeSeconds": 3000')
                await io.writelnErr('    }]')
                await io.writelnErr('  }')
                await io.writelnErr(chalk.gray('\nAlso ensure your bucket policy allows the required operations.'))
                throw mountError
              }
            } catch (error) {
              await io.writelnErr(chalk.red(`mount: failed to mount s3 filesystem: ${error instanceof Error ? error.message : 'Unknown error'}`))
              if (error instanceof Error && error.stack) {
                await io.writelnErr(chalk.gray(error.stack))
              }
              return 1
            }
            break
          } */
          case 'googledrive': {
            try {
              if (typeof window === 'undefined') {
                await io.writelnErr(chalk.red('mount: Google Drive API requires a browser environment'))
                return 1
              }

              // if (!mountOptions.apiKey) {
              //   await io.writelnErr(chalk.red('mount: googledrive filesystem requires apiKey option'))
              //   await io.writelnErr('Usage: mount -t googledrive TARGET -o apiKey=YOUR_API_KEY')
              //   return 1
              // }

              const win = window as unknown as { 
                gapi?: { 
                  load?: (module: string, callback: () => void) => void
                  client?: { 
                    init?: (config: { apiKey: string; discoveryDocs?: string[] }) => Promise<void>
                    request?: (config: { path: string }) => Promise<unknown>
                    setToken?: (token: { access_token: string }) => void
                    drive?: unknown
                  }
                }
                google?: {
                  accounts?: {
                    id?: {
                      initialize: (config: { client_id: string; callback: (response: { credential: string }) => void; scope?: string }) => void
                      prompt: (callback?: (notification: { isNotDisplayed: boolean; isSkippedMoment: boolean; isDismissedMoment: boolean }) => void) => void
                      renderButton: (element: HTMLElement, config: { theme?: string; size?: string; text?: string; width?: number; locale?: string }) => void
                    }
                    oauth2?: {
                      initTokenClient: (config: { client_id: string; scope: string; callback: (response: { access_token: string }) => void }) => { requestAccessToken: () => void }
                    }
                  }
                }
              }

              // Load Google Identity Services library if not already loaded
              if (!win.google?.accounts) {
                await io.writeln(chalk.gray('Loading Google Identity Services library...'))
                
                await new Promise<void>((resolve, reject) => {
                  const script = document.createElement('script')
                  script.src = 'https://accounts.google.com/gsi/client'
                  script.async = true
                  script.defer = true
                  script.onload = () => resolve()
                  script.onerror = () => reject(new Error('Failed to load Google Identity Services script'))
                  document.head.appendChild(script)
                })
              }

              // Wait for google.accounts to be available
              let attempts = 0
              while (!win.google?.accounts && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100))
                attempts++
              }

              if (!win.google?.accounts) {
                await io.writelnErr(chalk.red('mount: Failed to load Google Identity Services library'))
                return 1
              }

              // Load Google API script if not already loaded
              if (!win.gapi) {
                await io.writeln(chalk.gray('Loading Google API client library...'))
                
                await new Promise<void>((resolve, reject) => {
                  const script = document.createElement('script')
                  script.src = 'https://apis.google.com/js/api.js'
                  script.onload = () => resolve()
                  script.onerror = () => reject(new Error('Failed to load Google API script'))
                  document.head.appendChild(script)
                })
              }

              // Wait for gapi to be available
              attempts = 0
              while (!win.gapi && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100))
                attempts++
              }

              if (!win.gapi) {
                await io.writelnErr(chalk.red('mount: Failed to load Google API client library'))
                return 1
              }

              if (!win.gapi.client || !win.gapi.client.drive) {
                await io.writeln(chalk.gray('Initializing Google API client...'))

                const initConfig: { 
                  apiKey: string
                  discoveryDocs?: string[]
                } = {
                  apiKey: mountOptions.apiKey!,
                  discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
                }

                // Load the client module
                await new Promise<void>((resolve, reject) => {
                  if (!win.gapi?.load) {
                    reject(new Error('gapi.load is not available'))
                    return
                  }
                  win.gapi.load('client', () => {
                    if (!win.gapi?.client?.init) {
                      reject(new Error('gapi.client.init is not available'))
                      return
                    }
                    win.gapi.client.init(initConfig)
                      .then(() => {
                        setTimeout(() => {
                          if (win.gapi?.client?.drive) {
                            resolve()
                          } else {
                            reject(new Error('API discovery response missing required fields. The Drive API discovery document may have failed to load. This could be due to: network issues, invalid API key, or the Drive API not being enabled in your Google Cloud project.'))
                          }
                        }, 1000)
                      })
                      .catch((error: Error & { error?: string; details?: string }) => {
                        const err = error as Error & { error?: string; details?: string }
                        let errorMessage = 'Unknown error'
                        
                        errorMessage = JSON.stringify({
                          error: err.error,
                          details: err.details
                        }, null, 2)

                        const lowerError = err.error?.toLowerCase()
                        if (lowerError?.includes('discovery') || lowerError?.includes('API') || lowerError?.includes('required fields')) {
                          reject(new Error(`API discovery failed: ${errorMessage}. This could be due to: network issues, invalid API key, or the Drive API not being enabled in your Google Cloud project.`))
                        } else {
                          reject(new Error(err.error || err.details || 'Unknown error'))
                        }
                      })
                  })
                })

                // Verify Drive API is loaded
                if (!win.gapi?.client?.drive) {
                  // Try one more time with a longer wait
                  await new Promise<void>((resolve, reject) => {
                    let attempts = 0
                    const checkDrive = () => {
                      if (win.gapi?.client?.drive) {
                        resolve()
                      } else if (attempts < 10) {
                        attempts++
                        setTimeout(checkDrive, 200)
                      } else {
                        reject(new Error('Failed to load Drive API. The discovery document may have failed to load. Check the browser console for network errors (502 Bad Gateway suggests a network issue).'))
                      }
                    }
                    checkDrive()
                  })
                }
              }

              if (!win.gapi?.client?.drive) {
                await io.writelnErr(chalk.red('mount: Google Drive API is not available'))
                await io.writelnErr(chalk.yellow('Troubleshooting steps:'))
                await io.writelnErr('  1. Check the browser console for network errors (502 Bad Gateway suggests a network/server issue)')
                await io.writelnErr('  2. Verify your API key is valid and has the Drive API enabled')
                await io.writelnErr('  3. Ensure the Drive API is enabled in your Google Cloud project')
                await io.writelnErr('  4. Check if there are any API key restrictions (HTTP referrers, IP addresses, etc.)')
                await io.writelnErr('  5. Try refreshing the page and mounting again')
                return 1
              }

              // Handle OAuth authentication if clientId is provided
              if (mountOptions.clientId) {
                await io.writeln(chalk.gray('Checking authentication status...'))
                
                const driveScope = mountOptions.scope || 'https://www.googleapis.com/auth/drive'
                
                // Check if user is already authenticated
                try {
                  const client = win.gapi?.client
                  if (client?.request) {
                    await (client.request as (config: { path: string }) => Promise<unknown>)({
                      path: 'https://www.googleapis.com/drive/v3/about?fields=user'
                    })
                  }
                } catch (error) {
                  // User needs to authenticate using Google Identity Services
                  await io.writeln(chalk.gray('Authentication required. Please sign in to Google...'))
                  
                  try {
                    if (!win.google?.accounts?.oauth2) {
                      throw new Error('Google Identity Services OAuth2 is not available')
                    }
                    
                    await new Promise<void>((resolve, reject) => {
                      const tokenClient = win.google?.accounts?.oauth2?.initTokenClient({
                        client_id: mountOptions.clientId!,
                        scope: driveScope,
                        callback: (response: { access_token: string }) => {
                          if (response.access_token && win.gapi?.client?.setToken) {
                            win.gapi.client.setToken({ access_token: response.access_token })
                            resolve()
                          } else {
                            reject(new Error('Failed to obtain access token'))
                          }
                        },
                      })

                      tokenClient?.requestAccessToken()
                    })
                  } catch (authError) {
                    const authErrMsg = authError instanceof Error ? authError.message : String(authError)
                    if (authErrMsg.toLowerCase().includes('popup') || authErrMsg.toLowerCase().includes('blocked')) {
                      throw new Error(`OAuth authentication failed: ${authErrMsg}. Please allow popups for this site.`)
                    } else if (authErrMsg.toLowerCase().includes('origin') || authErrMsg.toLowerCase().includes('authorized')) {
                      throw new Error(`OAuth authentication failed: ${authErrMsg}. Your origin may not be authorized in Google Cloud Console. Add your current origin to the OAuth client's authorized JavaScript origins.`)
                    }
                    throw authError
                  }
                }
              }

              const drive = win.gapi.client.drive
              const cacheTTL = mountOptions.cacheTTL ? parseInt(mountOptions.cacheTTL) : undefined

              await kernel.filesystem.fsSync.mount(
                target,
                await resolveMountConfig({
                  backend: GoogleDrive,
                  drive: drive as never,
                  disableAsyncCache: true,
                  ...(cacheTTL && !isNaN(cacheTTL) ? { cacheTTL } : {})
                })
              )
            } catch (error) {
              let errorMessage = 'Unknown error'
              if (error instanceof Error) {
                errorMessage = error.message || error.toString()
              } else if (typeof error === 'string') {
                errorMessage = error
              } else if (error && typeof error === 'object') {
                // Try to extract error message from object
                const err = error as Record<string, unknown>
                errorMessage = 
                  (typeof err.message === 'string' ? err.message : '') ||
                  (typeof err.error === 'string' ? err.error : '') ||
                  (typeof err.details === 'string' ? err.details : '') ||
                  (typeof err.reason === 'string' ? err.reason : '') ||
                  (err.toString && typeof err.toString === 'function' ? err.toString() : '') ||
                  JSON.stringify(error)
              } else {
                errorMessage = String(error)
              }
              
              await io.writelnErr(chalk.red(`mount: failed to mount googledrive filesystem: ${errorMessage}`))
              
              // Provide specific guidance for common errors
              const lowerMessage = errorMessage.toLowerCase()
              if (lowerMessage.includes('popup') || lowerMessage.includes('blocked')) {
                await io.writelnErr(chalk.yellow('\nOAuth popup was blocked. Common causes:'))
                await io.writelnErr('  • Browser popup blocker is enabled')
                await io.writelnErr('  • Browser security restrictions')
                await io.writelnErr(chalk.gray('\nTo fix this:'))
                await io.writelnErr('  1. Allow popups for this site in your browser settings')
                await io.writelnErr('  2. Try the mount command again')
              } else if (lowerMessage.includes('origin') || lowerMessage.includes('authorized')) {
                await io.writelnErr(chalk.yellow('\nOAuth authentication failed. Common causes:'))
                await io.writelnErr('  • Your domain/origin is not authorized in Google Cloud Console')
                await io.writelnErr('  • Invalid or incorrect OAuth client ID')
                await io.writelnErr(chalk.gray('\nTo fix this:'))
                await io.writelnErr('  1. Go to Google Cloud Console > APIs & Services > Credentials')
                await io.writelnErr('  2. Find your OAuth 2.0 Client ID')
                await io.writelnErr('  3. Add your current origin to "Authorized JavaScript origins"')
                await io.writelnErr('     (e.g., http://localhost:30443 or your domain)')
                await io.writelnErr('  4. If you only need read-only access, try mounting without clientId:')
                await io.writelnErr('     mount -t googledrive /mnt/gdrive -o apiKey=YOUR_API_KEY')
              } else if (lowerMessage.includes('discovery') || lowerMessage.includes('api discovery') || lowerMessage.includes('required fields')) {
                await io.writelnErr(chalk.yellow('\nThe Drive API discovery document failed to load. Common causes:'))
                await io.writelnErr('  • Network connectivity issues (check for 502 Bad Gateway in console)')
                await io.writelnErr('  • Invalid or restricted API key')
                await io.writelnErr('  • Drive API not enabled in Google Cloud project')
                await io.writelnErr('  • CORS or browser security restrictions')
                await io.writelnErr(chalk.gray('\nCheck the browser console for detailed network error messages.'))
              } else if (lowerMessage.includes('network') || lowerMessage.includes('fetch') || lowerMessage.includes('502') || lowerMessage.includes('bad gateway')) {
                await io.writelnErr(chalk.yellow('\nNetwork error detected. This may be a temporary issue with Google\'s servers.'))
                await io.writelnErr('  • Wait a few moments and try again')
                await io.writelnErr('  • Check your internet connection')
                await io.writelnErr('  • Verify the API key is correct')
              }
              
              // Show full error details if it's an object (for debugging)
              if (error && typeof error === 'object' && !(error instanceof Error)) {
                try {
                  const errorStr = JSON.stringify(error, null, 2)
                  if (errorStr !== '{}' && errorStr.length < 500) {
                    await io.writelnErr(chalk.gray(`\nError details:\n${errorStr}`))
                  }
                } catch {
                  // Ignore JSON stringify errors
                }
              }
              
              if (error instanceof Error && error.stack && !lowerMessage.includes('discovery') && !lowerMessage.includes('network')) {
                await io.writelnErr(chalk.gray(`\nStack trace:\n${error.stack}`))
              }
              return 1
            }
            break
          }
          default:
            await io.writelnErr(chalk.red(`mount: unknown filesystem type '${type}'`))
            await io.writelnErr('Supported types: fetch, indexeddb, webstorage, webaccess, opfs, memory, singlebuffer, zip, iso, dropbox, s3, googledrive')
            return 1
        }

        const successMessage = source
          ? chalk.green(`Mounted ${type} filesystem from ${source} to ${target}`)
          : chalk.green(`Mounted ${type} filesystem at ${target}`)
        await io.writeln(successMessage)
        return 0
      } catch (error) {
        await io.writelnErr(chalk.red(`mount: failed to mount filesystem: ${error instanceof Error ? error.message : 'Unknown error'}`))
        return 1
      }
    }
  })
}
