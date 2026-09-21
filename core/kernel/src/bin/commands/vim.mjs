/**
 * Real `execve`'d `vim` -- migrated off `Kernel`'s legacy in-process shim (`core/utils/src/commands/
 * vim.ts`). This reads the files and works out the directory tree vim.wasm's virtual filesystem
 * needs; the editor itself (a 900x700 window running vim.wasm) is the `editor` presenter
 * (`#lib/presenters/editor.ts`), reached through `window_present`. Unlike the other presenters
 * this one holds the program until the editor exits, so `vim` returns vim's own status, and `^C` or
 * `kill` closes the window with the process.
 */

import { basename, resolvePath } from './lib/paths.mjs'
import { present } from './lib/present.mjs'

const syscalls = globalThis.ecmaosSyscalls
const { argv, env, exit, writeAll, getcwd, stat, isDirectory, open, read, close, O_RDONLY } = syscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: vim [OPTION]... [FILE]...
Vi IMproved - a text editor.

  FILE                    file(s) to edit
  --help, -h              display this help and exit

Examples:
  vim file.txt            edit file.txt
  vim file1.txt file2.txt edit multiple files`

const dirname = path => {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

/** `path` and every ancestor directory of it, up to but excluding `/`. */
function* ancestors(path) {
  let current = path
  while (current !== '/' && current !== '') {
    yield current
    current = dirname(current)
  }
}

function readText(path) {
  const fd = open(path, O_RDONLY)
  const decoder = new TextDecoder()
  const chunks = []
  const buffer = new Uint8Array(65536)
  try {
    while (true) {
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(decoder.decode(buffer.subarray(0, n), { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally {
    close(fd)
  }
  return chunks.join('')
}

const exists = path => {
  try {
    stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = argv.slice(1)

  if (args.length > 0 && (args[0] === '--help' || args[0] === '-h')) {
    err(usage)
    return 0
  }

  const files = args.filter(arg => arg && !arg.startsWith('-'))

  if (files.length === 0) {
    err('vim: no file specified')
    err("Try 'vim --help' for more information.")
    return 1
  }

  const home = env.HOME
  const expandTilde = path => (home && (path === '~' || path.startsWith('~/')) ? home + path.slice(1) : path)

  const fileContents = {}
  const dirs = new Set()
  const cmdArgs = []

  for (const dir of ancestors(getcwd())) dirs.add(dir)

  if (home) {
    for (const dir of ancestors(home)) dirs.add(dir)

    const vimrcPath = `${home}/.vim/vimrc`
    if (exists(vimrcPath)) fileContents['/home/web_user/.vim/vimrc'] = readText(vimrcPath)
  }

  for (const file of files) {
    const fullPath = resolvePath(getcwd(), expandTilde(file))

    if (exists(fullPath)) {
      if (isDirectory(fullPath)) {
        err(`vim: ${file}: Is a directory`)
        return 1
      }
      fileContents[fullPath] = readText(fullPath)
    } else {
      fileContents[fullPath] = ''
    }

    for (const dir of ancestors(dirname(fullPath))) dirs.add(dir)

    cmdArgs.push(fullPath)
  }

  // vim.wasm's own virtual filesystem already has these
  const emscriptenDefaultDirs = new Set(['/', '/tmp', '/home', '/home/web_user', '/home/web_user/.vim', '/dev'])
  const dirsArray = Array.from(dirs).filter(dir => !emscriptenDefaultDirs.has(dir)).sort((a, b) => a.length - b.length)

  try {
    const { result } = await present(syscalls, 'editor', { files: fileContents, dirs: dirsArray, cmdArgs, title: basename(files[0]) })
    for (const message of result.messages) err(message.text)
    return result.exitCode
  } catch (error) {
    err(`vim: ${error instanceof Error ? error.message : 'Unknown error'}`)
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`vim: ${error instanceof Error ? error.message : String(error)}`)
  exit(1)
}
