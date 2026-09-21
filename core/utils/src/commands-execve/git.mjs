/**
 * Real `execve`'d `git` -- migrated off `Kernel.executeCommand`'s legacy `Process`
 * (`core/utils/src/commands/git.ts`). `isomorphic-git` runs unchanged; the only new piece is
 * `fs` below, a small `fs.promises`-shaped adapter over the raw filesystem syscalls (what the
 * library's `fs` option asks for), so the same code that used to read `shell.context.fs` now reads
 * the real filesystem through `open`/`read`/`write`/`stat`/`readdir`. Network access (`clone`,
 * `push`, `pull`, `fetch`) goes through the library's `http/web` client, which is plain `fetch` and
 * works in a worker. Environment (`USER`, `EMAIL`, `HOSTNAME`, `GITHUB_TOKEN`, `GIT_CORS_PROXY`)
 * comes from the process's real environment. The original's chalk coloring is dropped, as in the
 * other migrated commands.
 */

import './lib/buffer-polyfill.mjs'
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { resolve, join, dirname, basename, relative } from './lib/path-utils.mjs'

const {
  argv, exit, writeAll, getcwd, env, open, read, close, stat: sysStat, lstat: sysLstat, readdir: sysReaddir,
  mkdir: sysMkdir, rmdir: sysRmdir, unlink: sysUnlink, readlink: sysReadlink, symlink: sysSymlink,
  O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC
} = globalThis.ecmaosSyscalls

const CORS_PROXY = 'https://cors.isomorphic-git.org'
const S_IFMT = 0xf000

const usage = `Usage: git [COMMAND] [OPTIONS] [ARGS...]

Common Git commands:
  init              Initialize a new repository
  clone <url>       Clone a repository
  add <file>...     Add files to staging
  commit -m <msg>   Commit staged changes
  status            Show working tree status
  log               Show commit logs
  branch            List or create branches
  checkout <branch> Switch branches
  push              Push to remote
  pull              Pull from remote
  fetch             Fetch from remote
  diff              Show changes
  rm <file>...      Remove files from git
  config            Get/set configuration
  remote            Manage remotes

  --help            display this help and exit`

const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text + '\n'))
const err = text => writeAll(2, encoder.encode(text + '\n'))
const messageOf = error => (error instanceof Error ? error.message : String(error))

function toStats(raw) {
  const type = raw.mode & S_IFMT
  return {
    mode: raw.mode,
    size: Number(raw.size),
    ino: Number(raw.ino),
    uid: raw.uid,
    gid: raw.gid,
    dev: Number(raw.dev),
    mtimeMs: raw.mtimeMs,
    ctimeMs: raw.ctimeMs,
    mtime: new Date(raw.mtimeMs),
    ctime: new Date(raw.ctimeMs),
    isFile: () => type === 0x8000,
    isDirectory: () => type === 0x4000,
    isSymbolicLink: () => type === 0xa000
  }
}

function readBytes(path) {
  const fd = open(path, O_RDONLY)
  const chunks = []
  try {
    while (true) {
      const chunk = new Uint8Array(65536)
      const n = read(fd, chunk, -1)
      if (n <= 0) break
      chunks.push(chunk.subarray(0, n))
    }
  } finally {
    close(fd)
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const encodingOf = options => (typeof options === 'string' ? options : options?.encoding)

/** The `fs` option `isomorphic-git` takes: an `fs.promises`-shaped object, here backed by raw syscalls. */
const fs = {
  promises: {
    async readFile(path, options) {
      const bytes = readBytes(path)
      return encodingOf(options) ? new TextDecoder().decode(bytes) : bytes
    },
    async writeFile(path, data, options) {
      const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, options?.mode ?? 0o644)
      try {
        writeAll(fd, typeof data === 'string' ? encoder.encode(data) : data)
      } finally {
        close(fd)
      }
    },
    async unlink(path) { sysUnlink(path) },
    async readdir(path) { return sysReaddir(path) },
    async mkdir(path, options) { sysMkdir(path, options?.mode ?? 0o777) },
    async rmdir(path) { sysRmdir(path) },
    async stat(path) { return toStats(sysStat(path)) },
    async lstat(path) { return toStats(sysLstat(path)) },
    async readlink(path) { return sysReadlink(path) },
    async symlink(target, path) { sysSymlink(target, path) }
  }
}

async function findRepoRoot(startDir) {
  let current = startDir
  while (true) {
    try {
      await fs.promises.stat(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

async function getRepoRoot(cwd) {
  const root = await findRepoRoot(cwd)
  if (!root) throw new Error('not a git repository (or any of the parent directories)')
  return root
}

function convertSshToHttps(url) {
  const match = url.match(/^git@([^:]+):(.+)$/)
  return match ? `https://${match[1]}/${match[2]}` : url
}

const authFor = () => (env.GITHUB_TOKEN ? () => ({ username: env.GITHUB_TOKEN }) : undefined)
const inRepo = path => path && path !== '.git' && !path.startsWith('..') && !path.startsWith('.git/')

async function collectFiles(searchDir, root) {
  const files = []
  let entries
  try { entries = await fs.promises.readdir(searchDir) } catch { return files }

  for (const entry of entries) {
    if (entry === '.git') continue
    const entryPath = join(searchDir, entry)
    let stats
    try { stats = await fs.promises.stat(entryPath) } catch { continue }

    if (stats.isDirectory()) files.push(...await collectFiles(entryPath, root))
    else if (stats.isFile()) {
      const gitRelative = relative(root, entryPath)
      if (inRepo(gitRelative)) files.push(gitRelative)
    }
  }
  return files
}

/** Each handler returns an exit code; anything it throws is reported as `fatal: ...` by `main`. */
const handlers = {
  async init(cwd, args) {
    const dir = args[0] ? resolve(cwd, args[0]) : cwd
    await git.init({ fs, dir })
    out(`Initialized empty Git repository in ${dir}/.git/`)
    return 0
  },

  async clone(cwd, args) {
    if (!args[0]) {
      err('fatal: You must specify a repository to clone.')
      return 1
    }
    const url = convertSshToHttps(args[0])
    const dir = args[1] ? resolve(cwd, args[1]) : resolve(cwd, basename(url.replace(/\.git$/, '')))

    out(`Cloning into '${basename(dir)}'...`)
    await git.clone({ fs, http, dir, url, corsProxy: env.GIT_CORS_PROXY || CORS_PROXY, onAuth: authFor() })
    out('done.')
    return 0
  },

  async add(cwd, args) {
    if (args.length === 0) {
      err('Nothing specified, nothing added.')
      return 0
    }

    const root = await getRepoRoot(cwd)
    const filesToAdd = new Set()

    for (const file of args) {
      if (!file) continue
      const target = resolve(cwd, file)
      try {
        const stats = await fs.promises.stat(target)
        if (stats.isDirectory()) {
          for (const path of await collectFiles(target, root)) if (inRepo(path)) filesToAdd.add(path)
        } else if (stats.isFile()) {
          const gitRelative = relative(root, target)
          if (inRepo(gitRelative)) filesToAdd.add(gitRelative)
        }
      } catch { /* unreadable or missing paths are skipped, as before */ }
    }

    let hasError = false
    for (const filepath of filesToAdd) {
      try {
        await git.add({ fs, dir: root, filepath })
      } catch (error) {
        err(`error: ${messageOf(error)}`)
        hasError = true
      }
    }
    return hasError ? 1 : 0
  },

  async commit(cwd, args) {
    let message
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-m' || args[i] === '--message') && i + 1 < args.length) message = args[++i]
      else if (args[i]?.startsWith('-m')) message = args[i].slice(2) || undefined
    }

    if (!message) {
      err('Aborting commit due to empty commit message.')
      return 1
    }

    const dir = await getRepoRoot(cwd)
    const username = env.USER || 'root'
    const email = env.EMAIL || `${username}@${env.HOSTNAME || 'localhost'}`
    const sha = await git.commit({ fs, dir, message, author: { name: username, email } })
    out(`[${sha.slice(0, 7)}] ${message}`)
    return 0
  },

  async status(cwd) {
    const dir = await getRepoRoot(cwd)
    const modified = []
    const added = []
    const deleted = []
    const untracked = []

    for (const [filepath, head, workdir, stage] of await git.statusMatrix({ fs, dir })) {
      if (head === 0 && stage === 2) added.push(filepath)
      else if (head === 1 && workdir === 0) deleted.push(filepath)
      else if (head === 1 && workdir === 2) modified.push(filepath)
      else if (head === 0 && workdir === 2 && stage === 0) untracked.push(filepath)
    }

    if (!modified.length && !added.length && !deleted.length && !untracked.length) {
      out('nothing to commit, working tree clean')
      return 0
    }

    if (modified.length) out('modified:   ' + modified.join(' '))
    if (added.length) out('new file:   ' + added.join(' '))
    if (deleted.length) out('deleted:    ' + deleted.join(' '))
    if (untracked.length) out('untracked:  ' + untracked.join(' '))
    return 0
  },

  async log(cwd, args) {
    let depth = 10
    let oneline = false
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--oneline') oneline = true
      else if (args[i] === '-n' && i + 1 < args.length) depth = parseInt(args[++i] || '10', 10) || depth
      else if (args[i]?.startsWith('-n')) depth = parseInt(args[i].slice(2) || '10', 10) || depth
    }

    const dir = await getRepoRoot(cwd)
    for (const { oid } of await git.log({ fs, dir, depth })) {
      const { commit } = await git.readCommit({ fs, dir, oid })
      if (oneline) {
        out(`${oid.slice(0, 7)} ${commit.message.split('\n')[0]}`)
      } else {
        out(`commit ${oid}`)
        out(`Author: ${commit.author.name} <${commit.author.email}>`)
        out(`Date:   ${new Date(commit.author.timestamp * 1000).toLocaleString()}`)
        out('')
        for (const line of commit.message.split('\n')) out(`    ${line}`)
        out('')
      }
    }
    return 0
  },

  async branch(cwd, args) {
    const dir = await getRepoRoot(cwd)

    if (args.length === 0) {
      const current = await git.currentBranch({ fs, dir })
      for (const branch of await git.listBranches({ fs, dir })) out(branch === current ? `* ${branch}` : `  ${branch}`)
      return 0
    }

    if (!args[0]) {
      err('fatal: branch name required')
      return 1
    }
    await git.branch({ fs, dir, ref: args[0], checkout: false })
    out(`Created branch '${args[0]}'`)
    return 0
  },

  async checkout(cwd, args) {
    if (args.length === 0) {
      err('fatal: You must specify a branch to checkout.')
      return 1
    }
    const dir = await getRepoRoot(cwd)
    await git.checkout({ fs, dir, ref: args[0] })
    out(`Switched to branch '${args[0]}'`)
    return 0
  },

  push: (cwd, args) => syncRemote(cwd, args, 'Pushing to', git.push),
  pull: (cwd, args) => syncRemote(cwd, args, 'Pulling from', git.pull),

  async fetch(cwd, args) {
    const dir = await getRepoRoot(cwd)
    const remote = args[0] || 'origin'
    out(`Fetching from ${remote}...`)
    await git.fetch({ fs, http, dir, remote, corsProxy: CORS_PROXY, onAuth: authFor() })
    out('done.')
    return 0
  },

  async diff(cwd, args) {
    const dir = await getRepoRoot(cwd)

    if (args[0]) {
      const filepath = relative(dir, resolve(cwd, args[0]))
      const status = await git.status({ fs, dir, filepath })
      if (status === '*modified' || status === '*added' || status === '*deleted') {
        out(`diff --git a/${filepath} b/${filepath}`)
        out(`--- a/${filepath}`)
        out(`+++ b/${filepath}`)
        out(`Status: ${status}`)
      } else {
        out(`No changes to ${filepath}`)
      }
    } else {
      for (const [filepath] of await git.statusMatrix({ fs, dir })) out(`diff --git a/${filepath} b/${filepath}`)
    }
    return 0
  },

  async rm(cwd, args) {
    if (args.length === 0) {
      err('Nothing specified, nothing removed.')
      return 0
    }
    const dir = await getRepoRoot(cwd)
    for (const file of args) {
      if (!file) continue
      try {
        await git.remove({ fs, dir, filepath: relative(dir, resolve(cwd, file)) })
      } catch (error) {
        err(`error: ${messageOf(error)}`)
      }
    }
    return 0
  },

  async config(cwd, args) {
    const dir = await getRepoRoot(cwd)

    if (args.length === 0) {
      try {
        const content = await fs.promises.readFile(join(dir, '.git', 'config'), 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (trimmed && !trimmed.startsWith('[') && !trimmed.startsWith('#') && trimmed.includes('=')) out(trimmed)
        }
      } catch {
        out('No configuration found')
      }
      return 0
    }

    if (args.length === 1 && args[0]) {
      const value = await git.getConfig({ fs, dir, path: args[0] })
      if (value) out(value)
      return 0
    }

    if (args.length === 2 && args[0] && args[1]) {
      await git.setConfig({ fs, dir, path: args[0], value: args[1] })
      return 0
    }

    err('usage: git config <key> [value]')
    return 1
  },

  async remote(cwd, args) {
    const dir = await getRepoRoot(cwd)
    const [sub, name, url] = args

    if (!sub) {
      for (const { remote } of await git.listRemotes({ fs, dir })) out(remote)
      return 0
    }

    if (sub === '-v' || sub === '--verbose') {
      for (const remote of await git.listRemotes({ fs, dir })) {
        out(`${remote.remote}\t${remote.url} (fetch)`)
        out(`${remote.remote}\t${remote.url} (push)`)
      }
      return 0
    }

    if ((sub === 'add' || sub === 'set-url') && args.length === 3 && name && url) {
      await git.setConfig({ fs, dir, path: `remote.${name}.url`, value: convertSshToHttps(url) })
      return 0
    }

    if ((sub === 'remove' || sub === 'rm') && args.length === 2 && name) {
      const configFile = join(dir, '.git', 'config')
      const newLines = []
      let skipSection = false
      for (const line of (await fs.promises.readFile(configFile, 'utf-8')).split('\n')) {
        if (!line) continue
        if (line.trim() === `[remote "${name}"]`) { skipSection = true; continue }
        if (skipSection && line.trim().startsWith('[')) skipSection = false
        if (!skipSection) newLines.push(line)
      }
      await fs.promises.writeFile(configFile, newLines.join('\n'), 'utf-8')
      return 0
    }

    if (sub === 'show' && args.length === 2 && name) {
      const remoteUrl = await git.getConfig({ fs, dir, path: `remote.${name}.url` })
      if (!remoteUrl) {
        err(`fatal: No such remote '${name}'`)
        return 1
      }
      out(`* remote ${name}`)
      out(`  Fetch URL: ${remoteUrl}`)
      out(`  Push  URL: ${remoteUrl}`)
      return 0
    }

    err('usage: git remote [-v | --verbose]')
    err('   or: git remote add <name> <url>')
    err('   or: git remote remove <name>')
    err('   or: git remote set-url <name> <url>')
    err('   or: git remote show <name>')
    return 1
  }
}

async function syncRemote(cwd, args, verb, operation) {
  const dir = await getRepoRoot(cwd)
  const remote = args[0] || 'origin'
  const ref = args[1] || (await git.currentBranch({ fs, dir })) || 'main'

  out(`${verb} ${remote}...`)
  await operation({ fs, http, dir, remote, ref, corsProxy: CORS_PROXY, onAuth: authFor() })
  out('done.')
  return 0
}

async function main() {
  const [subcommand, ...args] = argv.slice(1)

  if (!subcommand || (args.length === 0 && (subcommand === '--help' || subcommand === '-h'))) {
    err(usage)
    return 0
  }

  const handler = Object.hasOwn(handlers, subcommand) ? handlers[subcommand] : undefined
  if (!handler) {
    err(`git: '${subcommand}' is not a git command. See 'git --help'.`)
    return 1
  }

  try {
    return await handler(getcwd(), args)
  } catch (error) {
    err(`fatal: ${messageOf(error)}`)
    return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`git: ${messageOf(error)}`)
  exit(1)
}
