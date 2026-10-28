/**
 * `inotifywait`: wait for files to change, through the kernel's watches (`watch_add`, `watch_next`). What can be seen
 * is what zenfs reports: a file written (`MODIFY`), and an entry made or removed (`CREATE`, `DELETE`, with `ISDIR` for a
 * directory; a watched file that goes is `DELETE_SELF`). A rename is a `DELETE` of the old name and a `CREATE` of the new
 * one, not `MOVED_FROM`/`MOVED_TO`, and there is nothing for opening, reading, closing or changing a mode, so `-e` with
 * only those finds nothing to wait for. Without `-m` it ends after the first event (status 0), or at `-t` (status 2).
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { strftime } from './lib/strftime.mjs'

const { argv, exit, writeAll, stat, unlink, custom, getpid, open, close, O_WRONLY, O_CREAT } = globalThis.ecmaosSyscalls
const O_APPEND = 0x400
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text.endsWith('\n') ? text : text + '\n'))

const usage = `inotifywait 4.23.9.0 (ecmaOS)
Wait for a particular event on a file or set of files.
Usage: inotifywait [ options ] file1 [ file2 ] [ file3 ] [ ... ]
Options:
\t-h|--help     \tShow this help text.
\t--exclude <pattern>
\t              \tExclude all events on files matching the extended regular expression <pattern>.
\t--include <pattern>
\t              \tExclude all events on files except the ones matching the extended regular expression <pattern>.
\t-m|--monitor  \tKeep listening for events forever or until --timeout expires.
\t-r|--recursive\tWatch directories recursively.
\t-o|--outfile <file>
\t              \tPrint events to <file> rather than stdout.
\t-q|--quiet    \tPrint less (only print events).
\t-qq           \tPrint nothing (not even events).
\t--format <fmt>\tPrint using a specified printf-like format string; read the man page for more details.
\t--timefmt <fmt>\tstrftime-compatible format string for use with %T in --format string.
\t-c|--csv      \tPrint events in CSV format.
\t-t|--timeout <seconds>
\t              \tWhen listening for a single event, time out after waiting for an event for <seconds> seconds.
\t-e|--event <event1> [ -e|--event <event2> ... ]
\t\tListen for specific event(s).  If omitted, all events are listened for.

Exit status:
\t0  -  An event you asked to watch for was received.
\t1  -  An event you did not ask to watch for was received (usually delete_self or unmount), or some error occurred.
\t2  -  The --timeout option was given and no events occurred in the specified interval of time.

Events:
\tmodify\t\tfile or directory contents were written
\tcreate\t\tfile or directory created within watched directory
\tdelete\t\tfile or directory deleted within watched directory
\tdelete_self\tfile or directory was deleted`

const SEEN = ['MODIFY', 'CREATE', 'DELETE', 'DELETE_SELF']
const UNSEEN = ['ACCESS', 'ATTRIB', 'CLOSE_WRITE', 'CLOSE_NOWRITE', 'CLOSE', 'OPEN', 'MOVED_TO', 'MOVED_FROM', 'MOVE', 'MOVE_SELF', 'UNMOUNT']

const exists = path => { try { stat(path); return true } catch { return false } }
const isDir = path => { try { return (stat(path).mode & 0o170000) === 0o040000 } catch { return false } }
const csvField = text => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'hmrqo:ct:e:sd',
    long: { help: 'h', monitor: 'm', recursive: 'r', quiet: 'q', outfile: { key: 'o', arg: 'required' }, csv: 'c', timeout: { key: 't', arg: 'required' }, event: { key: 'e', arg: 'required' }, format: { key: 'format', arg: 'required' }, timefmt: { key: 'timefmt', arg: 'required' }, exclude: { key: 'exclude', arg: 'required' }, excludei: { key: 'excludei', arg: 'required' }, include: { key: 'include', arg: 'required' }, includei: { key: 'includei', arg: 'required' }, syslog: 's', daemon: 'd', 'no-dereference': 'P', fromfile: { key: 'fromfile', arg: 'required' } }
  })
  if (error) { err(`inotifywait: ${error}`); err(tryHelp('inotifywait')); return 1 }
  let monitor = false, recursive = false, quiet = 0, outfile, csv = false, timeout, format, timefmt
  const wanted = new Set()
  let exclude, include
  const files = [...operands]
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'm') monitor = true
    else if (key === 'r') recursive = true
    else if (key === 'q') quiet++
    else if (key === 'o') outfile = value
    else if (key === 'c') csv = true
    else if (key === 't') {
      if (!/^\d+(\.\d+)?$/.test(value)) { err(`The timeout value you provided is not valid: ${value}`); return 1 }
      timeout = Number(value)
    } else if (key === 'e') {
      for (const name of value.split(',')) {
        const event = name.trim().toUpperCase()
        if (!SEEN.includes(event) && !UNSEEN.includes(event)) { err(`'${name}' is not a valid event!  Run with the '--help' option to see a list of events.`); return 1 }
        wanted.add(event === 'MOVE' ? 'MOVED_TO' : event)
      }
    } else if (key === 'format') format = value.replace(/\\n/g, '\n')
    else if (key === 'timefmt') timefmt = value
    else if (key === 'exclude' || key === 'excludei') exclude = new RegExp(value, key === 'excludei' ? 'i' : '')
    else if (key === 'include' || key === 'includei') include = new RegExp(value, key === 'includei' ? 'i' : '')
    else if (key === 'd') { err('inotifywait: --daemon is not supported: run it in the background with &'); return 1 }
    else if (key === 'fromfile') {
      try { files.push(...readTextFile(value).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('@'))) } catch (e) { err(`Couldn't open ${value}: ${reasonOf(e)}`); return 1 }
    }
  }
  if (files.length === 0) { err('No files specified to watch!'); return 1 }
  if (wanted.size && ![...wanted].some(event => SEEN.includes(event))) {
    err(`inotifywait: none of the events asked for can be seen here: there are only ${SEEN.map(event => event.toLowerCase()).join(', ')}`)
    return 1
  }
  for (const event of wanted) if (UNSEEN.includes(event) && quiet < 2) err(`inotifywait: the ${event.toLowerCase()} event cannot be seen here; not waiting for it`)
  if (timefmt === undefined && format?.includes('%T')) { err('%T is in --format string, but --timefmt was not specified.'); return 1 }

  if (quiet === 0) err('Setting up watches.' + (recursive ? '  Beware: since -r was given, this may take a while!' : ''))
  const watches = new Map()
  for (const file of files) {
    try {
      const id = await custom('watch_add', file, recursive ? 1 : 0)
      watches.set(id, { path: file, dir: isDir(file) })
    } catch (e) { err(`Couldn't watch ${file}: ${reasonOf(e)}`); return 1 }
  }
  if (quiet === 0) err('Watches established.')

  let outFd = 1
  if (outfile !== undefined) {
    try { outFd = open(outfile, O_WRONLY | O_CREAT | O_APPEND, 0o644) } catch (e) { err(`Couldn't open ${outfile}: ${reasonOf(e)}`); return 1 }
  }
  const scratch = `/tmp/.inotifywait.${getpid()}.${Math.random().toString(36).slice(2, 8)}`
  const deadline = timeout ? Date.now() + timeout * 1000 : undefined
  const ids = JSON.stringify([...watches.keys()])
  try {
    for (;;) {
      const left = deadline === undefined ? -1 : deadline - Date.now()
      if (deadline !== undefined && left <= 0) return 2
      const count = await custom('watch_next', ids, left, scratch)
      if (!count) continue
      const events = JSON.parse(readTextFile(scratch))
      try { unlink(scratch) } catch { /* gone */ }
      for (const { id, type, name } of events) {
        const watch = watches.get(id)
        if (!watch) continue
        let directory, file, kind
        if (watch.dir) {
          const slash = name.lastIndexOf('/')
          directory = watch.path.replace(/\/?$/, '/') + (slash === -1 ? '' : name.slice(0, slash + 1))
          file = slash === -1 ? name : name.slice(slash + 1)
          const full = directory + file
          kind = type === 'change' ? ['MODIFY'] : exists(full) ? ['CREATE'] : ['DELETE']
          if (kind[0] !== 'MODIFY' && isDir(full)) kind.push('ISDIR')
          if (!file && kind[0] === 'DELETE') kind = ['DELETE_SELF']
        } else {
          directory = watch.path
          file = ''
          kind = type === 'change' ? ['MODIFY'] : exists(watch.path) ? ['MODIFY'] : ['DELETE_SELF']
        }
        if (wanted.size && !wanted.has(kind[0])) continue
        const subject = directory + file
        if (exclude?.test(subject) || (include && !include.test(subject))) continue
        if (quiet < 2) {
          let line
          if (format !== undefined) {
            line = format.replace(/%(w|f|e|T|Xe|.e)/g, (match, code) => code === 'w' ? directory : code === 'f' ? file : code === 'e' ? kind.join(',') : code === 'T' ? strftime(timefmt, { ms: Date.now() }) : kind.join(code[0]))
          } else if (csv) line = [directory, kind.join(','), file].map(csvField).join(',')
          else line = `${directory} ${kind.join(',')} ${file}`
          writeAll(outFd, encoder.encode(line + (format !== undefined && format.endsWith('\n') ? '' : '\n')))
        }
        if (kind[0] === 'DELETE_SELF' && !watch.dir) {
          watches.delete(id)
          if (watches.size === 0) return monitor ? 0 : wanted.size && !wanted.has('DELETE_SELF') ? 1 : 0
        }
        if (!monitor) return 0
      }
    }
  } finally {
    for (const id of watches.keys()) await custom('watch_rm', id).catch(() => {})
    if (outFd !== 1) close(outFd)
  }
}

try {
  exit(await main())
} catch (error) {
  err(`inotifywait: ${reasonOf(error)}`)
  exit(1)
}
