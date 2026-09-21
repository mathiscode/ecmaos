/**
 * Real `execve`'d `sockets` -- migrated off `Kernel`'s legacy in-process `Process`
 * (`core/utils/src/commands/sockets.ts`) per this session's M1 pass. `kernel.sockets` is a live,
 * main-thread-only registry of real `WebSocket`/`WebTransport` instances, so `list`/`create`/
 * `close`/`show` each reach it through their own custom syscall (`sockets_list`/`sockets_create`/
 * `sockets_close`/`sockets_show`, `#lib/main-thread-syscalls.ts`), using `lib/scratch.mjs`'s shared
 * scratch-file bridge the same way `df.mjs`/`ps.mjs` do. Unlike `windows`, a connection's own id is
 * already a real, structured-clone-safe string, so no handle indirection layer is needed here --
 * `close`/`show`'s id argument goes straight through to the syscall, fuzzy 8-char-prefix matching
 * and all (see `findSocketConnection` on the syscall side).
 *
 * No ANSI colour or `columnify`'s box-drawing here -- kept plain to match every other migrated
 * coreutil's stdout-is-just-text convention; the original's `chalk` state/type colouring is dropped
 * (see `ls.mjs`/`ps.mjs` for the same precedent), but the `columnify`-shaped table layout is kept.
 *
 * `create`/`close`/`show`'s syscall handlers write `{ error: message }` to their scratch file on
 * failure rather than throwing -- a plain thrown `Error` gets collapsed into a bare `-EIO` by
 * `@zenfs/linux`'s own `dispatch()`, discarding the real message (confirmed by hand, and by a real
 * test that caught it before this shipped) -- so each of these three checks `result.error` after
 * reading its scratch file back and re-throws locally, where the outer `try`/`catch` below can print
 * the real message same as every other error path in this program.
 */

import columnify from 'columnify'
import { readBackAndDelete, scratchPath } from './lib/scratch.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, exit, write, custom } = syscalls

const usage = `Usage: sockets [COMMAND] [OPTIONS]

Manage socket connections (WebSocket and WebTransport).

Commands:
  list, ls              List all active connections
  create, c <url>       Create a new connection
  close, d <id>         Close a connection by ID
  show, s <id>          Show detailed information about a connection
  --help, -h            Display this help and exit

Options:
  -t, --type <type>     Connection type: websocket or webtransport (for create)
  -p, --protocols       WebSocket protocols (comma-separated, for create)

Examples:
  sockets list
  sockets create wss://echo.websocket.org
  sockets create https://example.com:443 -t webtransport
  sockets close abc-123-def-456
  sockets show abc-123-def-456`

function formatAge(createdMs) {
  const age = Math.floor((Date.now() - createdMs) / 1000)
  return age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`
}

async function listConnections() {
  const path = scratchPath('sockets-list')
  await custom('sockets_list', path)
  const raw = await readBackAndDelete(syscalls, path)
  const connections = JSON.parse(raw)

  if (connections.length === 0) {
    write(1, new TextEncoder().encode('No active connections.\n'))
    return 0
  }

  const data = connections.map((conn, index) => {
    const id = conn.id.substring(0, 8)
    const type = conn.type === 'websocket' ? 'WS' : 'WT'
    const url = conn.url.length > 50 ? conn.url.substring(0, 47) + '...' : conn.url
    return { '#': `${index + 1}`, ID: id, TYPE: type, STATE: conn.state, AGE: formatAge(conn.created), URL: url }
  })

  const table = columnify(data, {
    columns: ['#', 'ID', 'TYPE', 'STATE', 'AGE', 'URL'],
    columnSplitter: '  ',
    config: {
      '#': { maxWidth: 4 },
      ID: { maxWidth: 10 },
      TYPE: { maxWidth: 4 },
      STATE: { maxWidth: 10 },
      AGE: { maxWidth: 4 }
    }
  })

  write(1, new TextEncoder().encode(table + '\n'))
  return 0
}

async function showConnection(id) {
  const path = scratchPath('sockets-show')
  await custom('sockets_show', id, path)
  const raw = await readBackAndDelete(syscalls, path)
  const conn = JSON.parse(raw)
  if (conn.error) throw new Error(conn.error)

  const age = Math.floor((Date.now() - conn.created) / 1000)
  const ageStr = age < 60 ? `${age} seconds` :
                 age < 3600 ? `${Math.floor(age / 60)} minutes, ${age % 60} seconds` :
                 `${Math.floor(age / 3600)} hours, ${Math.floor((age % 3600) / 60)} minutes`

  const lines = [
    'Connection Details',
    '─'.repeat(40),
    `ID:        ${conn.id}`,
    `Type:      ${conn.type === 'websocket' ? 'WebSocket' : 'WebTransport'}`,
    `State:     ${conn.state}`,
    `URL:       ${conn.url}`,
    `Created:   ${new Date(conn.created).toISOString()}`,
    `Age:       ${ageStr}`
  ]

  if (conn.type === 'websocket') {
    lines.push(`Protocol:  ${conn.protocol || '(none)'}`)
    lines.push(`Extensions: ${conn.extensions || '(none)'}`)
    lines.push(`BinaryType: ${conn.binaryType}`)
    lines.push(`ReadyState: ${conn.readyState} (${conn.state})`)
  }

  write(1, new TextEncoder().encode(lines.join('\n') + '\n'))
  return 0
}

async function createConnection(url, type, protocols) {
  const path = scratchPath('sockets-create')
  await custom('sockets_create', url, type ?? '', protocols ?? '', path)
  const raw = await readBackAndDelete(syscalls, path)
  const conn = JSON.parse(raw)
  if (conn.error) throw new Error(conn.error)

  const lines = [
    `Created ${conn.type === 'websocket' ? 'WebSocket' : 'WebTransport'} connection: ${conn.id.substring(0, 8)}`,
    `URL: ${conn.url}`,
    `State: ${conn.state}`
  ]
  write(1, new TextEncoder().encode(lines.join('\n') + '\n'))
  return 0
}

async function closeConnection(id) {
  const path = scratchPath('sockets-close')
  await custom('sockets_close', id, path)
  const raw = await readBackAndDelete(syscalls, path)
  const conn = JSON.parse(raw)
  if (conn.error) throw new Error(conn.error)
  write(1, new TextEncoder().encode(`Closed connection: ${conn.id.substring(0, 8)}\n`))
  return 0
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    write(2, new TextEncoder().encode(usage + '\n'))
    return 0
  }

  if (args.length === 0 || args[0] === 'list' || args[0] === 'ls') {
    return await listConnections()
  }

  const command = args[0]
  let type
  let protocols

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-t' || arg === '--type') {
      if (i + 1 < args.length) { i++; type = args[i] }
      else { write(2, new TextEncoder().encode('sockets: --type requires a value\n')); return 1 }
    } else if (arg === '-p' || arg === '--protocols') {
      if (i + 1 < args.length) { i++; protocols = args[i] }
      else { write(2, new TextEncoder().encode('sockets: --protocols requires a value\n')); return 1 }
    }
  }

  if (command === 'create' || command === 'c') {
    if (args.length < 2 || !args[1] || args[1].startsWith('-')) {
      write(2, new TextEncoder().encode('sockets: create requires a URL\n'))
      write(2, new TextEncoder().encode('Try "sockets --help" for more information.\n'))
      return 1
    }
    return await createConnection(args[1], type, protocols)
  }

  if (command === 'close' || command === 'd') {
    if (args.length < 2 || !args[1] || args[1].startsWith('-')) {
      write(2, new TextEncoder().encode('sockets: close requires a connection ID\n'))
      write(2, new TextEncoder().encode('Try "sockets --help" for more information.\n'))
      return 1
    }
    return await closeConnection(args[1])
  }

  if (command === 'show' || command === 's') {
    if (args.length < 2 || !args[1] || args[1].startsWith('-')) {
      write(2, new TextEncoder().encode('sockets: show requires a connection ID\n'))
      write(2, new TextEncoder().encode('Try "sockets --help" for more information.\n'))
      return 1
    }
    return await showConnection(args[1])
  }

  write(2, new TextEncoder().encode(`sockets: unknown command: ${command}\n`))
  write(2, new TextEncoder().encode('Try "sockets --help" for more information.\n'))
  return 1
}

try {
  exit(await main())
} catch (error) {
  write(2, new TextEncoder().encode(`sockets: ${error instanceof Error ? error.message : String(error)}\n`))
  exit(1)
}
