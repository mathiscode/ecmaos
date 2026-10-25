#!/usr/bin/env node
// The initfs: `core/kernel/public/initfs/` is what a new machine's filesystem starts with, and `initfs.tar.gz` beside it
// is what the kernel actually fetches and unpacks. A machine re-unpacks `/usr/share` whenever the tarball's sha256
// changes, so the tarball is built to depend only on the folder's contents: names sorted, owner root, modes 0644 or
// 0755, one fixed mtime (the extractor ignores mtimes and modes) and a gzip header with no timestamp.
//
//   node utils/initfs.mjs build   rebuild initfs.tar.gz from the folder (what `pnpm sync:initfs` runs); needs GNU tar.
//                                 With --if-possible (the kernel's dev and build) it warns and leaves the tarball alone
//                                 when there is no GNU tar, instead of failing
//   node utils/initfs.mjs check   exit 1 if the tarball and the folder differ, or a copy in the folder is behind its
//                                 source (the README, the API docs, the license texts); says which sync fixes it
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..')
const folder = path.join(root, 'core/kernel/public/initfs')
const tarball = path.join(root, 'core/kernel/public/initfs.tar.gz')
const share = path.join(folder, 'usr/share')
const MTIME = '2026-01-01 00:00:00Z'

// Every copy in the initfs of a file kept elsewhere in the repository, and the sync that refreshes it
const MIRRORS = [
  { source: 'README.md', copy: 'core/kernel/README.md', sync: 'sync:readme' },
  { source: 'README.md', copy: path.relative(root, path.join(share, 'docs/@ecmaos/kernel/index.md')), sync: 'sync:readme' },
  { source: 'docs', copy: path.relative(root, path.join(share, 'docs/@ecmaos/kernel/docs')), sync: 'sync:docs' },
  ...['LICENSE', 'LICENSE-APACHE', 'LICENSE-MIT'].map(name => ({ source: name, copy: path.relative(root, path.join(share, 'licenses/@ecmaos/kernel', name)), sync: 'sync:licenses' })),
  { source: 'core/utils/licenses', copy: path.relative(root, path.join(share, 'licenses/@ecmaos/coreutils')), sync: 'sync:licenses' },
  { source: 'core/utils-copyleft/licenses', copy: path.relative(root, path.join(share, 'licenses/@ecmaos/coreutils-copyleft')), sync: 'sync:licenses' },
  // The LGPL libraries' texts also travel with the Node host and the desktop app
  ...['core/node/licenses', 'core/jaffa/src-tauri/licenses'].flatMap(target => [
    ...['@zenfs', 'utilium', 'memium'].map(name => ({ source: path.relative(root, path.join(share, 'licenses', name)), copy: `${target}/${name}`, sync: 'sync:licenses' })),
    ...['LICENSE', 'LICENSE-APACHE', 'LICENSE-MIT'].map(name => ({ source: name, copy: `${target}/ecmaos/${name}`, sync: 'sync:licenses' }))
  ])
]

function gnuTar() {
  for (const name of ['gtar', 'tar']) {
    const result = spawnSync(name, ['--version'], { encoding: 'utf8' })
    if (result.status === 0 && result.stdout.includes('GNU tar')) return name
  }
  return undefined
}

/** Every file under `dir`, as relative path -> contents (directories are implied by the paths) */
function files(dir) {
  const found = new Map()
  const walk = sub => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const relative = sub ? `${sub}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(relative)
      else found.set(relative, readFileSync(path.join(dir, relative)))
    }
  }
  if (statSync(dir).isDirectory()) walk('')
  else found.set('', readFileSync(dir))
  return found
}

/** What differs between two trees of files: the paths only one has, then the paths whose contents differ */
function compare(a, b) {
  const differences = []
  for (const name of a.keys()) if (!b.has(name)) differences.push(`only in the source: ${name || '(the file)'}`)
  for (const name of b.keys()) if (!a.has(name)) differences.push(`only in the copy: ${name || '(the file)'}`)
  for (const [name, bytes] of a) if (b.has(name) && !bytes.equals(b.get(name))) differences.push(`differs: ${name || '(the file)'}`)
  return differences
}

function build() {
  const tarCommand = gnuTar()
  if (!tarCommand) {
    if (process.argv.includes('--if-possible')) {
      console.warn('initfs: no GNU tar (as gtar or tar), so initfs.tar.gz was not rebuilt; run pnpm check:initfs before committing a change to the initfs')
      return
    }
    console.error('initfs: building the tarball needs GNU tar (as gtar or tar) for --sort and the fixed owner and modes')
    process.exit(2)
  }
  const tar = execFileSync(tarCommand, [
    '--create', '--format=gnu', '--sort=name', `--mtime=${MTIME}`,
    '--owner=root:0', '--group=root:0', '--mode=a+rX,u+w,go-w',
    '--file=-', '--directory', folder, '.'
  ], { maxBuffer: 1 << 30 })
  writeFileSync(tarball, gzipSync(tar, { level: 9 }))
  console.log(`initfs: wrote ${path.relative(root, tarball)} (${files(folder).size} files)`)
}

function check() {
  const problems = []

  for (const mirror of MIRRORS) {
    const source = path.join(root, mirror.source)
    const copy = path.join(root, mirror.copy)
    if (!existsSync(copy)) { problems.push(`${mirror.copy} is missing (pnpm ${mirror.sync})`); continue }
    const differences = compare(files(source), files(copy))
    if (differences.length) problems.push(`${mirror.copy} is behind ${mirror.source} (pnpm ${mirror.sync}):\n    ${differences.slice(0, 10).join('\n    ')}${differences.length > 10 ? `\n    and ${differences.length - 10} more` : ''}`)
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'ecmaos-initfs-'))
  try {
    const result = spawnSync('tar', ['-x', '-f', '-', '-C', scratch], { input: gunzipSync(readFileSync(tarball)), maxBuffer: 1 << 30 })
    if (result.status !== 0) throw new Error(`tar: ${result.stderr}`)
    const differences = compare(files(folder), files(scratch))
    if (differences.length) problems.push(`${path.relative(root, tarball)} is behind ${path.relative(root, folder)} (pnpm sync:initfs):\n    ${differences.slice(0, 10).join('\n    ')}${differences.length > 10 ? `\n    and ${differences.length - 10} more` : ''}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if (problems.length) {
    console.error(`initfs: out of date\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log('initfs: the tarball matches the folder, and every copy matches its source')
}

const command = process.argv[2]
if (command === 'build') build()
else if (command === 'check') check()
else {
  console.error('usage: initfs.mjs build | check')
  process.exit(2)
}
