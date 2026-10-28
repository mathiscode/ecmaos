/**
 * `pstree`: show the processes as a tree, from `/proc`. Children are sorted by name (by pid with `-n`), identical leaves
 * are merged as `N*[name]` unless `-c` or `-p`, and a change of user is shown with `-u`. pid 1's tree comes first; any
 * other process with no parent here (the kernel starts some itself) roots a tree of its own after it.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { processes, userNames } from './lib/procs.mjs'

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`pstree: ${text}\n`))

const usage = `Usage: pstree [-acglpsStTuZ] [ -h | -H PID ] [ -n | -N type ]
              [ -A | -G | -U ] [ PID | USER ]
   or: pstree -V

Display a tree of processes.

  -a, --arguments     show command line arguments
  -A, --ascii         use ASCII line drawing characters
  -c, --compact-not   don't compact identical subtrees
  -l, --long          don't truncate long lines
  -n, --numeric-sort  sort output by PID
  -p, --show-pids     show PIDs; implies -c
  -s, --show-parents  show parents of the selected process
  -t, --thread-names  show full thread names
  -T, --hide-threads  hide threads, show only processes
  -u, --uid-changes   show uid transitions
  -U, --unicode       use UTF-8 (Unicode) line drawing characters
  -V, --version       display version information

  PID    start at this PID; default is 1 (init)
  USER   show only trees rooted at processes of this user`

function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'aAcGglnpsStTuUVZhH:',
    long: { arguments: 'a', ascii: 'A', 'compact-not': 'c', long: 'l', 'numeric-sort': 'n', 'show-pids': 'p', 'show-pgids': 'g', 'show-parents': 's', 'thread-names': 't', 'hide-threads': 'T', 'uid-changes': 'u', unicode: 'U', version: 'V', vt100: 'G', highlight: 'h', help: 'help' }
  })
  if (error) { err(error); writeAll(2, encoder.encode(usage + '\n')); return 1 }
  const o = { args: false, ascii: false, compact: true, numeric: false, pids: false, pgids: false, parents: false, uid: false, long: false }
  for (const [key] of options) {
    if (key === 'help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(2, encoder.encode('pstree (PSmisc) 23.7 (ecmaOS)\n')); return 0 }
    if (key === 'a') { o.args = true; o.compact = false }
    else if (key === 'A') o.ascii = true
    else if (key === 'U' || key === 'G') o.ascii = false
    else if (key === 'c') o.compact = false
    else if (key === 'n') o.numeric = true
    else if (key === 'p') { o.pids = true; o.compact = false }
    else if (key === 'g') { o.pgids = true; o.compact = false }
    else if (key === 's') o.parents = true
    else if (key === 'u') o.uid = true
    else if (key === 'l') o.long = true
  }
  if (!options.some(([key]) => key === 'U' || key === 'G') && /^(C|POSIX)$/.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) o.ascii = true
  if (operands.length > 1) { writeAll(2, encoder.encode(usage + '\n')); return 1 }

  const list = processes()
  const byPid = new Map(list.map(p => [p.pid, p]))
  const children = new Map()
  for (const p of list) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p)
  }
  const names = userNames()
  const lines = { ascii: { one: '---', first: '-+-', mid: ' |-', last: ' `-', bar: ' | ', none: '   ' }, unicode: { one: '───', first: '─┬─', mid: ' ├─', last: ' └─', bar: ' │ ', none: '   ' } }[o.ascii ? 'ascii' : 'unicode']

  const label = (p, parent) => {
    let text = o.args && p.args.length ? p.args.join(' ') : p.comm
    const marks = []
    if (o.pids) marks.push(String(p.pid))
    if (o.pgids) marks.push(String(p.pgrp))
    if (o.args) text = marks.length ? `${p.comm},${marks.join(',')}${p.args.length > 1 ? ' ' + p.args.slice(1).join(' ') : ''}` : text
    else if (marks.length) text += `(${marks.join(',')})`
    if (o.uid && parent && parent.uid !== p.uid) text += `(${names.get(p.uid) ?? p.uid})`
    return text
  }
  const sorted = kids => [...kids].sort((a, b) => (o.numeric ? a.pid - b.pid : a.comm.localeCompare(b.comm) || a.pid - b.pid))

  /** The lines of the tree under `p`, its label first */
  const draw = (p, parent, seen = new Set()) => {
    seen.add(p.pid)
    const own = label(p, parent)
    let kids = sorted((children.get(p.pid) ?? []).filter(kid => kid.pid !== p.pid && !seen.has(kid.pid)))
    // identical leaves are one entry, N*[name]
    const entries = []
    for (const kid of kids) {
      const leaf = !(children.get(kid.pid) ?? []).some(grandchild => grandchild.pid !== kid.pid)
      const prior = o.compact && leaf && entries.find(entry => entry.leaf && entry.label === label(kid, p))
      if (prior) prior.count++
      else entries.push({ kid, leaf, label: label(kid, p), count: 1 })
    }
    kids = entries
    if (!kids.length) return [own]
    const pad = ' '.repeat([...own].length)
    const out = []
    kids.forEach((entry, i) => {
      const sub = entry.leaf ? [entry.count > 1 ? `${entry.count}*[${entry.label}]` : entry.label] : draw(entry.kid, p, seen)
      const only = kids.length === 1
      const last = i === kids.length - 1
      const connector = only ? lines.one : i === 0 ? lines.first : last ? lines.last : lines.mid
      const continuation = only || last ? lines.none : lines.bar
      sub.forEach((line, j) => out.push(j === 0 ? (i === 0 ? own : pad) + connector + line : pad + continuation + line))
    })
    return out
  }

  let roots
  const arg = operands[0]
  if (arg !== undefined && /^\d+$/.test(arg)) {
    const start = byPid.get(Number(arg))
    if (!start) return 1
    roots = [start]
  } else if (arg !== undefined) {
    const uid = [...names].find(([, name]) => name === arg)?.[0]
    if (uid === undefined) { err(`No such user name: ${arg}`); return 1 }
    // the highest processes of that user: those whose parent is someone else's
    roots = list.filter(p => p.uid === uid && byPid.get(p.ppid)?.uid !== uid)
  } else {
    const init = byPid.get(1)
    const orphans = list.filter(p => p.pid !== 1 && !byPid.has(p.ppid))
    roots = [...(init ? [init] : []), ...sorted(orphans)]
  }
  const output = []
  for (const root of roots) {
    let tree = draw(root, byPid.get(root.ppid))
    if (o.parents && arg !== undefined) {
      // the chain of parents above, each one level in
      const chain = []
      for (let p = byPid.get(root.ppid); p; p = byPid.get(p.ppid)) { chain.unshift(p); if (p.pid === 1) break }
      for (const ancestor of chain.reverse()) {
        const own = label(ancestor, byPid.get(ancestor.ppid))
        const pad = ' '.repeat([...own].length)
        tree = tree.map((line, i) => (i === 0 ? own + lines.one + line : pad + lines.none + line))
      }
    }
    output.push(...tree)
  }
  const width = Number(env.COLUMNS) || 132
  writeAll(1, encoder.encode(output.map(line => (o.long || [...line].length <= width ? line : [...line].slice(0, width - 1).join('') + '+')).join('\n') + (output.length ? '\n' : '')))
  return 0
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
