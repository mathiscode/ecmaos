/**
 * Real `execve`'d `mount`. The backends (browser storage, the File System Access picker, Google
 * Drive's OAuth scripts, the live mount table) are main-thread only, so the work runs behind the
 * `fs_mount` syscall (`#lib/mount-backends.ts`); this program parses arguments, reads `/etc/fstab`
 * for `-a`, and prints the lines that come back. Mirrors `umount.mjs`.
 */

import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const { argv, exit, write, custom, open, read, close, unlink, getcwd } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const writeln = (fd, text) => write(fd, encoder.encode(text + '\n'))

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

const NO_SOURCE_TYPES = ['memory', 'singlebuffer', 'webstorage', 'webaccess', 'opfs', 'xml', 'dropbox', 'googledrive']
const REQUIRES_SOURCE_TYPES = ['zip', 'iso', 'fetch', 'indexeddb']

function parseOptions(options) {
  const parsed = {}
  for (const option of options?.split(',') ?? []) {
    const [key, value] = option.split('=')
    if (key && value) parsed[key.trim()] = value.trim()
  }
  return parsed
}

/** `null` when the file doesn't exist */
function readTextFile(path) {
  let fd
  try {
    fd = open(path, 0)
  } catch {
    return null
  }
  const chunks = []
  try {
    while (true) {
      const buffer = new Uint8Array(65536)
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.subarray(0, n))
      if (n < 65536) break
    }
  } finally {
    close(fd)
  }
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap(chunk => [...chunk])))
}

function parseFstab(content) {
  const entries = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const [source = '', target = '', type = ''] = parts
    if (!target || !type) continue
    entries.push({ source, target, type, options: parts.slice(3).join(' ') || undefined })
  }
  return entries
}

async function callSyscall(request) {
  const path = scratchPath('mount')
  await custom('fs_mount', JSON.stringify(request), path)
  return JSON.parse(await readBackAndDelete({ open, read, close, unlink }, path))
}

function printLines(lines) {
  for (const { stream, text } of lines) writeln(stream === 'err' ? 2 : 1, text)
}

async function listMounts() {
  const { mounts } = await callSyscall({ action: 'list' })
  if (mounts.length === 0) {
    writeln(1, 'No filesystems mounted.')
    return 0
  }
  for (const { target, name } of mounts) writeln(1, `${target.padEnd(30)} ${name}`)
  return 0
}

async function mountAll() {
  const content = readTextFile('/etc/fstab')
  if (content === null) {
    writeln(2, 'mount: /etc/fstab not found')
    return 1
  }

  const entries = parseFstab(content)
  if (entries.length === 0) {
    writeln(1, 'No entries found in /etc/fstab')
    return 0
  }

  writeln(1, `Mounting ${entries.length} filesystem(s) from /etc/fstab...`)
  let successCount = 0
  let failCount = 0

  for (const entry of entries) {
    const type = entry.type.toLowerCase()
    const target = entry.target.startsWith('/') ? entry.target : `/${entry.target}`

    if (entry.source && NO_SOURCE_TYPES.includes(type)) {
      writeln(2, `mount: ${entry.type} filesystem does not require a source, ignoring source for ${target}`)
    }
    if (!entry.source && REQUIRES_SOURCE_TYPES.includes(type)) {
      writeln(2, `mount: skipping ${target}: ${entry.type} filesystem requires a source`)
      failCount++
      continue
    }

    const outcome = await callSyscall({
      action: 'mount',
      type: entry.type,
      source: NO_SOURCE_TYPES.includes(type) ? '' : entry.source,
      target,
      cwd: '/',
      options: parseOptions(entry.options),
      interactive: false
    })

    printLines(outcome.lines)
    if (outcome.code === 0) successCount++
    else failCount++
  }

  writeln(1, `\nMount summary: ${successCount} succeeded, ${failCount} failed`)
  return failCount > 0 ? 1 : 0
}

async function main() {
  const args = argv.slice(1)

  if (args[0] === '--help' || args[0] === '-h') {
    writeln(2, usage)
    return 0
  }

  let listMode = false
  let allMode = false
  let type
  let options
  const positional = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-l' || arg === '--list') {
      listMode = true
    } else if (arg === '-a' || arg === '--all') {
      allMode = true
    } else if (arg === '-t' || arg === '--type') {
      if (i + 1 >= args.length) {
        writeln(2, "mount: option requires an argument -- 't'")
        return 1
      }
      type = args[++i]
    } else if (arg === '-o' || arg === '--options') {
      if (i + 1 >= args.length) {
        writeln(2, "mount: option requires an argument -- 'o'")
        return 1
      }
      options = args[++i]
    } else if (arg && !arg.startsWith('-')) {
      positional.push(arg)
    }
  }

  if (listMode || (args.length === 0 && !allMode)) return await listMounts()
  if (allMode) return await mountAll()

  if (positional.length === 0) {
    writeln(2, 'mount: missing target argument')
    writeln(2, "Try 'mount --help' for more information.")
    return 1
  }

  if (positional.length > 2) {
    writeln(2, 'mount: too many arguments')
    writeln(2, "Try 'mount --help' for more information.")
    return 1
  }

  if (!type) {
    writeln(2, 'mount: filesystem type must be specified')
    writeln(2, "Try 'mount --help' for more information.")
    return 1
  }

  const lowerType = type.toLowerCase()

  if (positional.length === 2 && NO_SOURCE_TYPES.includes(lowerType)) {
    writeln(2, `mount: ${lowerType} filesystem does not require a source`)
    writeln(2, `Usage: mount -t ${lowerType} TARGET`)
    return 1
  }

  if (positional.length === 1 && (lowerType === 'zip' || lowerType === 'iso')) {
    writeln(2, `mount: ${lowerType} filesystem requires a source file or URL`)
    writeln(2, `Usage: mount -t ${lowerType} SOURCE TARGET`)
    return 1
  }

  const outcome = await callSyscall({
    action: 'mount',
    type,
    source: positional.length === 2 ? positional[0] : '',
    target: positional[positional.length - 1],
    cwd: getcwd(),
    options: parseOptions(options),
    interactive: true
  })

  printLines(outcome.lines)
  return outcome.code
}

try {
  exit(await main())
} catch (error) {
  writeln(2, `mount: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
