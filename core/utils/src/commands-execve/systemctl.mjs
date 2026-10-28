/**
 * `systemctl`: control the service manager in `/sbin/init` (`lib/service-manager.ts`). Starting, stopping, reloading
 * and killing units are init's: `systemctl` leaves it a request in `/run/systemd` and sends `SIGHUP`, then waits for the
 * answer, so they are root's. Enabling, disabling and masking are links in `/etc/systemd/system` (and `/etc/rcN.d` for
 * a SysV script) that this program makes itself. What units are doing is `/run/systemd/state.json`, which init keeps.
 * `status` shows the unit's processes from `/proc` (its process group stands in for its control group) and its last
 * lines in the log.
 */

import { getopt, tryHelp } from './lib/getopt.mjs'
import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { isTty, pagerTty } from './lib/tty.mjs'
import { page } from './lib/pager.mjs'
import { formatShort, readJournal, unitMatcher } from './lib/journal.mjs'
import { dropIns, enablement, isMasked, loadUnits, RUN_DIR, STATE_FILE, TARGETS, unitName, wantedByLinks } from '../lib/unit-file.ts'

const sys = globalThis.ecmaosSyscalls
const { argv, env, exit, writeAll, open, close, getuid, geteuid, readdir, readlink, symlink, unlink, mkdir, stat, lstat, custom, spawn, waitpid, getcwd, O_WRONLY, O_CREAT, O_TRUNC } = sys
const encoder = new TextEncoder()
const out = text => writeAll(1, encoder.encode(text))
const err = text => writeAll(2, encoder.encode(text.endsWith('\n') ? text : text + '\n'))

const usage = `systemctl [OPTIONS...] COMMAND ...

Query or send control commands to the system manager.

Unit Commands:
  list-units [PATTERN...]             List units currently in memory
  list-timers [PATTERN...]            List timer units currently in memory
  is-active PATTERN...                Check whether units are active
  is-failed [PATTERN...]              Check whether units are failed
  status [PATTERN...|PID...]          Show runtime status of one or more units
  show [PATTERN...|JOB...]            Show properties of one or more units
  cat PATTERN...                      Show files and drop-ins of specified units
  start UNIT...                       Start (activate) one or more units
  stop UNIT...                        Stop (deactivate) one or more units
  reload UNIT...                      Reload one or more units
  restart UNIT...                     Start or restart one or more units
  try-restart UNIT...                 Restart one or more units if active
  reload-or-restart UNIT...           Reload one or more units if possible, otherwise start or restart
  kill UNIT...                        Send signal to processes of a unit
  reset-failed [PATTERN...]           Reset failed state for all, one, or more units

Unit File Commands:
  list-unit-files [PATTERN...]        List installed unit files
  enable [UNIT...|PATH...]            Enable one or more unit files
  disable UNIT...                     Disable one or more unit files
  reenable UNIT...                    Reenable one or more unit files
  is-enabled UNIT...                  Check whether unit files are enabled
  mask UNIT...                        Mask one or more units
  unmask UNIT...                      Unmask one or more units
  edit UNIT...                        Edit one or more unit files
  get-default                         Get the name of the default target

Manager State Commands:
  daemon-reload                       Reload systemd manager configuration

System Commands:
  is-system-running                   Check whether system is fully running
  poweroff                            Shut down and power-off the system
  reboot                              Shut down and reboot the system
  halt                                Shut down and halt the system

Options:
  -h --help              Show this help
     --version           Show package version
  -t --type=TYPE         List units of a particular type
     --state=STATE       List units with particular LOAD or SUB or ACTIVE state
     --failed            Shortcut for --state=failed
  -a --all               Show all properties/all units currently in memory
  -p --property=NAME     Show only properties by this name
  -P NAME                Equivalent to --value --property=NAME
     --value             When showing properties, only print the value
  -q --quiet             Suppress output
     --now               Start or stop unit after enabling or disabling it
     --no-pager          Do not pipe output into a pager
     --no-legend         Do not print a legend (column headers and hints)
     --plain             Print unit dependencies as a list instead of a tree
  -l --full              Don't ellipsize unit names on output
  -n --lines=INTEGER     Number of journal entries to show
  -s --signal=SIGNAL     Which signal to send
     --force             When enabling unit files, override existing symlinks`

const SIGNALS = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, TERM: 15, CONT: 18, STOP: 19 }
const color = isTty(1) && !env.NO_COLOR && env.SYSTEMD_COLORS !== '0'
const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text

const reader = {
  readdir(path) { try { return readdir(path) } catch { return [] } },
  readFile(path) { try { return readTextFile(path) } catch { return undefined } },
  readlink(path) { try { return readlink(path) } catch { return undefined } },
  isExecutable(path) { try { const info = stat(path); return (info.mode & 0o170000) === 0o100000 && (info.mode & 0o111) !== 0 } catch { return false } }
}

const exists = path => { try { lstat(path); return true } catch { return false } }
const isRoot = () => geteuid() === 0

function readState() {
  const text = reader.readFile(STATE_FILE)
  if (text === undefined) return undefined
  try { return JSON.parse(text).units ?? {} } catch { return {} }
}

function requireManager() {
  const state = readState()
  if (state === undefined) {
    err('System has not been booted with systemd as init system (PID 1). Can\'t operate.\nFailed to connect to bus: Host is down')
    exit(1)
  }
  return state
}

/** Sends init a request and waits for its answer */
async function ask(action, units, extra = {}) {
  if (!isRoot()) {
    for (const unit of units.length ? units : ['']) err(`Failed to ${action.replace(/-/g, ' ')} ${unit}: Access denied`.replace(/ : /, ': '))
    return { ok: false, errors: [], denied: true }
  }
  requireManager()
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const request = `${RUN_DIR}/req-${id}.json`
  const reply = `${RUN_DIR}/rep-${id}.json`
  const fd = open(`${request}.tmp`, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
  try { writeAll(fd, encoder.encode(JSON.stringify({ id, action, units, uid: getuid(), ...extra }))) } finally { close(fd) }
  sys.rename(`${request}.tmp`, request)
  await custom('proc_kill', 1, 1)
  // a stop may wait out a unit's TimeoutStopSec= and then its SIGKILL
  const deadline = Date.now() + 10 * 60_000
  for (let delay = 20; Date.now() < deadline; delay = Math.min(delay * 2, 250)) {
    const text = reader.readFile(reply)
    if (text !== undefined) {
      try { unlink(reply) } catch { /* taken */ }
      try { return JSON.parse(text) } catch { return { ok: false, errors: ['Bad answer from init'] } }
    }
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  return { ok: false, errors: ['Connection timed out'] }
}

/** Expands patterns (`*`, `?`) against the names given; a plain name is taken as given, with `.service` added */
function expand(patterns, names) {
  const result = []
  for (const pattern of patterns) {
    if (/[*?[]/.test(pattern)) {
      const regex = new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
      result.push(...names.filter(name => regex.test(name) || regex.test(name.replace(/\.service$/, ''))))
    } else result.push(unitName(pattern))
  }
  return [...new Set(result)]
}

const dateText = ms => {
  const date = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  const zone = date.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop()
  return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`
}

function ago(ms) {
  let seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  const parts = []
  for (const [unit, size] of [['month', 2629800], ['week', 604800], ['day', 86400], ['h', 3600], ['min', 60], ['s', 1]]) {
    if (seconds >= size || (unit === 's' && parts.length === 0)) {
      const n = Math.floor(seconds / size)
      seconds -= n * size
      parts.push(unit.length > 3 ? `${n} ${unit}${n === 1 ? '' : 's'}` : `${n}${unit}`)
    }
    if (parts.length === 2) break
  }
  return `${parts.join(' ')} ago`
}

/** `/proc`'s view of the processes: pid, parent, group and command line */
function processes() {
  const list = []
  for (const name of reader.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const statText = reader.readFile(`/proc/${name}/stat`)
    if (!statText) continue
    const close = statText.lastIndexOf(')')
    const fields = statText.slice(close + 2).split(' ')
    const comm = statText.slice(statText.indexOf('(') + 1, close)
    const cmdline = (reader.readFile(`/proc/${name}/cmdline`) ?? '').split('\0').filter(Boolean).join(' ') || comm
    list.push({ pid: Number(name), comm, ppid: Number(fields[1]), pgrp: Number(fields[2]), cmdline })
  }
  return list
}

/** The unit's program: `systemd-cat`'s child when its output is logged, else the main process itself */
function mainOf(pid, procs) {
  const wrapper = procs.find(p => p.pid === pid)
  if (wrapper?.comm === 'systemd-cat' || /\bsystemd-cat\b/.test(wrapper?.cmdline ?? '')) return procs.find(p => p.ppid === pid) ?? wrapper
  return wrapper
}

function units() {
  return loadUnits(reader)
}

function activeText(state) {
  const active = state?.ActiveState ?? 'inactive'
  const sub = state?.SubState ?? 'dead'
  const text = `${active} (${sub})`
  return active === 'active' || active === 'reloading' ? paint('1;32', text) : active === 'failed' ? paint('1;31', text) : active === 'activating' || active === 'deactivating' ? paint('1', text) : text
}

const dot = state => {
  const active = state?.ActiveState ?? 'inactive'
  return active === 'active' || active === 'reloading' ? paint('1;32', '●') : active === 'failed' ? paint('1;31', '×') : active === 'activating' || active === 'deactivating' ? paint('1', '●') : '○'
}

function targetState(name, state) {
  const booted = state !== undefined
  return booted && ['multi-user.target', 'graphical.target', 'default.target', 'basic.target', 'sysinit.target', 'network.target', 'timers.target'].includes(name)
    ? { ActiveState: 'active', SubState: 'active' } : { ActiveState: 'inactive', SubState: 'dead' }
}

async function show(lines, quiet, noPager) {
  if (quiet) return
  const tty = noPager ? -1 : pagerTty()
  if (tty < 0 || lines.length < 2) { out(lines.join('\n') + (lines.length ? '\n' : '')); return }
  await page(lines, tty, 'systemctl')
}

function table(rows, legend) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].replace(/\x1b\[[0-9;]*m/g, '').length)))
  const lines = rows.map((row, r) => row.map((cell, i) => i === row.length - 1 ? cell : cell + ' '.repeat(widths[i] - cell.replace(/\x1b\[[0-9;]*m/g, '').length)).join(' ').trimEnd())
  if (!legend) lines.shift()
  return lines
}

function listUnits(patterns, opts) {
  const state = readState() ?? {}
  const all = units()
  const names = new Set([...Object.keys(state)])
  for (const target of Object.keys(TARGETS)) names.add(target)
  if (opts.all) for (const name of all.keys()) names.add(name)
  let list = [...names].sort()
  if (patterns.length) list = expand(patterns, list).filter(name => names.has(name))
  const rows = [['  UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION']]
  let shown = 0
  for (const name of list) {
    const isTarget = name.endsWith('.target')
    if (opts.type && !opts.type.split(',').some(type => name.endsWith(`.${type}`))) continue
    const s = isTarget ? targetState(name, readState()) : state[name] ?? { ActiveState: 'inactive', SubState: 'dead' }
    if (opts.state && !opts.state.split(',').some(wanted => [s.ActiveState, s.SubState, 'loaded'].includes(wanted))) continue
    if (!opts.all && !opts.state && s.ActiveState === 'inactive') continue
    const unit = all.get(name)
    const load = isTarget || unit ? (isMasked(reader, name) ? 'masked' : 'loaded') : 'not-found'
    const failed = s.ActiveState === 'failed'
    const mark = failed ? paint('1;31', '●') : ' '
    rows.push([`${mark} ${name}`, load, failed ? paint('1;31', s.ActiveState) : s.ActiveState, failed ? paint('1;31', s.SubState) : s.SubState, isTarget ? TARGETS[name] : unit?.description ?? state[name]?.Description ?? name])
    shown++
  }
  const lines = table(rows, opts.legend)
  if (opts.legend) {
    lines.push('', 'LOAD   = Reflects whether the unit definition was properly loaded.', 'ACTIVE = The high-level unit activation state, i.e. generalization of SUB.', 'SUB    = The low-level unit activation state, values depend on unit type.', '')
    lines.push(`${shown} loaded units listed.${opts.all ? '' : ' Pass --all to see loaded but inactive units, too.'}`, 'To show all installed unit files use \'systemctl list-unit-files\'.')
  }
  return lines
}

function listUnitFiles(patterns, opts) {
  const all = units()
  const names = new Set([...all.keys(), ...Object.keys(TARGETS)])
  for (const dir of ['/etc/systemd/system']) for (const file of reader.readdir(dir)) if (isMasked(reader, file)) names.add(file)
  let list = [...names].sort()
  if (patterns.length) list = expand(patterns, list).filter(name => names.has(name))
  const rows = [['UNIT FILE', 'STATE', 'PRESET']]
  for (const name of list) {
    if (opts.type && !opts.type.split(',').some(type => name.endsWith(`.${type}`))) continue
    const state = enablement(reader, all.get(name), name)
    if (opts.state && !opts.state.split(',').includes(state)) continue
    const shown = state === 'enabled' ? paint('1;32', state) : state === 'masked' ? paint('1;31', state) : state === 'disabled' ? paint('1;33', state) : state
    rows.push([name, shown, state === 'static' || state === 'masked' ? '-' : 'enabled'])
  }
  const lines = table(rows, opts.legend)
  if (opts.legend) lines.push('', `${rows.length - 1} unit files listed.`)
  return lines
}

function statusOf(name, opts) {
  const state = readState() ?? {}
  const all = units()
  const unit = all.get(name)
  const isTarget = name.endsWith('.target')
  if (!unit && !isTarget && !isMasked(reader, name)) {
    err(`Unit ${name} could not be found.`)
    return { lines: [], code: 4 }
  }
  const s = isTarget ? targetState(name, readState()) : state[name]
  const lines = []
  const description = isTarget ? TARGETS[name] : unit?.description
  lines.push(`${dot(s)} ${name}${description && description !== name ? ` - ${description}` : ''}`)
  if (isMasked(reader, name)) lines.push(`     Loaded: masked (Reason: Unit ${name} is masked.)`)
  else {
    const where = isTarget ? `/lib/systemd/system/${name}` : unit.path
    const enabled = enablement(reader, unit, name)
    lines.push(`     Loaded: loaded (${where}; ${enabled}; preset: enabled)`)
    const drops = isTarget ? [] : dropIns(reader, name)
    if (drops.length) lines.push(`    Drop-In: ${drops.map(drop => drop.path).join('\n             ')}`)
  }
  const since = s?.ActiveState === 'active' ? s.ActiveEnterTimestamp : s?.InactiveEnterTimestamp
  lines.push(`     Active: ${activeText(s)}${since ? ` since ${dateText(since)}; ${ago(since)}` : ''}`)
  if (unit?.documentation.length) lines.push(`       Docs: ${unit.documentation.join('\n             ')}`)
  if (s?.ExecMainCode && s.ActiveState !== 'active' && s.ExecMain) {
    const result = s.ExecMainCode === 'killed' ? `code=killed, signal=${Object.keys(SIGNALS).find(key => SIGNALS[key] === s.ExecMainStatus) ?? s.ExecMainStatus}` : `code=exited, status=${s.ExecMainStatus}/${s.ExecMainStatus === 0 ? 'SUCCESS' : 'FAILURE'}`
    lines.push(`    Process: ${s.MainPID || '-'} ExecStart=${s.ExecMain} (${result})`)
  }
  if (s?.MainPID) {
    const procs = processes()
    const main = mainOf(s.MainPID, procs)
    if (main) {
      lines.push(`   Main PID: ${main.pid} (${main.comm})`)
      const group = procs.filter(p => p.pgrp === s.MainPID && !(p.pid === s.MainPID && p.pid !== main.pid))
      lines.push(`      Tasks: ${group.length}`)
      lines.push(`     CGroup: /system.slice/${name}`)
      group.forEach((p, i) => lines.push(`             ${i === group.length - 1 ? '└─' : '├─'}${p.pid} ${opts.full ? p.cmdline : p.cmdline.slice(0, 120)}`))
    }
  }
  if (!isTarget && opts.lines > 0) {
    const entries = readJournal({ kernel: false }).filter(unitMatcher(name, s?.Identifiers ?? [])).slice(-opts.lines)
    if (entries.length) lines.push('', ...entries.map(formatShort))
  }
  const code = s?.ActiveState === 'active' || s?.ActiveState === 'reloading' ? 0 : 3
  return { lines, code }
}

function systemStatus() {
  const state = readState()
  const host = (reader.readFile('/proc/sys/kernel/hostname') ?? reader.readFile('/etc/hostname') ?? 'localhost').trim()
  const failed = Object.values(state ?? {}).filter(s => s.ActiveState === 'failed').length
  const running = state === undefined ? 'offline' : failed ? 'degraded' : 'running'
  const boot = Number((/^btime (\d+)/m.exec(reader.readFile('/proc/stat') ?? '') ?? [])[1] ?? 0) * 1000
  return [
    `${failed ? paint('1;31', '●') : paint('1;32', '●')} ${host}`,
    `    State: ${failed ? paint('1;31', running) : paint('1;32', running)}`,
    `    Units: ${units().size + Object.keys(TARGETS).length} loaded (incl. loaded aliases)`,
    '     Jobs: 0 queued',
    `   Failed: ${failed} units`,
    ...(boot ? [`    Since: ${dateText(boot)}; ${ago(boot)}`] : []),
    '  systemd: ecmaOS /sbin/init',
    '   CGroup: /'
  ]
}

const PROPERTY_ORDER = ['Id', 'Names', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath', 'Type', 'Restart', 'RestartUSec', 'MainPID', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'ExecMainCode', 'ExecMainStatus', 'Result', 'NRestarts', 'User', 'Group', 'WorkingDirectory', 'WantedBy', 'After', 'Before', 'Wants', 'Requires', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp']

function properties(name) {
  const state = (readState() ?? {})[name] ?? {}
  const unit = units().get(name)
  const procs = state.MainPID ? processes() : []
  const main = state.MainPID ? mainOf(state.MainPID, procs) : undefined
  const time = ms => ms ? dateText(ms) : ''
  return {
    Id: name, Names: name, Description: unit?.description ?? TARGETS[name] ?? name,
    LoadState: unit || name.endsWith('.target') ? (isMasked(reader, name) ? 'masked' : 'loaded') : 'not-found',
    ActiveState: state.ActiveState ?? 'inactive', SubState: state.SubState ?? 'dead',
    UnitFileState: enablement(reader, unit, name), FragmentPath: unit?.path ?? '',
    Type: unit?.type ?? '', Restart: unit?.restart ?? '', RestartUSec: unit ? `${unit.restartSec}ms` : '',
    MainPID: String(main?.pid ?? 0),
    ExecMainStartTimestamp: time(state.ExecMainStartTimestamp), ExecMainExitTimestamp: time(state.ExecMainExitTimestamp),
    ExecMainCode: String(state.ExecMainCode === 'killed' ? 2 : state.ExecMainCode === 'exited' ? 1 : 0), ExecMainStatus: String(state.ExecMainStatus ?? 0),
    Result: state.Result ?? 'success', NRestarts: String(state.NRestarts ?? 0),
    User: unit?.user ?? '', Group: unit?.group ?? '', WorkingDirectory: unit?.workingDirectory ?? '',
    WantedBy: (unit?.wantedBy ?? []).join(' '), After: (unit?.after ?? []).join(' '), Before: (unit?.before ?? []).join(' '),
    Wants: (unit?.wants ?? []).join(' '), Requires: (unit?.requires ?? []).join(' '),
    ActiveEnterTimestamp: time(state.ActiveEnterTimestamp), InactiveEnterTimestamp: time(state.InactiveEnterTimestamp)
  }
}

/** A link, reported as systemctl reports it */
function link(target, path) {
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (!exists(dir)) mkdir(dir, 0o755)
  if (exists(path)) {
    if (reader.readlink(path) === target) return
    unlink(path)
  }
  symlink(target, path)
  err(`Created symlink '${path}' → '${target}'.`)
}

function removeLink(path) {
  if (reader.readlink(path) === undefined) return
  unlink(path)
  err(`Removed '${path}'.`)
}

function enable(names, force) {
  const all = units()
  let status = 0
  for (const name of names) {
    if (isMasked(reader, name)) { err(`Failed to enable unit: Unit ${name} is masked.`); status = 1; continue }
    const unit = all.get(name)
    if (!unit) { err(`Failed to enable unit: Unit file ${name} does not exist.`); status = 1; continue }
    if (unit.sysv) {
      const script = name.replace(/\.service$/, '')
      err(`Synchronizing state of ${name} with SysV service script.`)
      for (const level of ['0', '1', '2', '3', '4', '5', '6']) {
        const dir = `/etc/rc${level}.d`
        for (const file of reader.readdir(dir)) if (file.slice(3) === script) try { unlink(`${dir}/${file}`) } catch { /* gone */ }
        link(`../init.d/${script}`, `${dir}/${['2', '3', '4', '5'].includes(level) ? 'S01' : 'K01'}${script}`)
      }
      continue
    }
    const targets = [...unit.wantedBy, ...unit.requiredBy]
    if (targets.length === 0 && unit.alias.length === 0) {
      err(`The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=,\nAlso=, or Alias= settings in the [Install] section, and DefaultInstance= for\ntemplate units). This means they are not meant to be enabled or disabled using systemctl.`)
      continue
    }
    for (const target of unit.wantedBy) link(unit.path, `/etc/systemd/system/${target}.wants/${name}`)
    for (const target of unit.requiredBy) link(unit.path, `/etc/systemd/system/${target}.requires/${name}`)
    for (const alias of unit.alias) link(unit.path, `/etc/systemd/system/${alias}`)
    void force
  }
  return status
}

function disable(names) {
  const all = units()
  for (const name of names) {
    const unit = all.get(name)
    if (unit?.sysv) {
      const script = name.replace(/\.service$/, '')
      err(`Synchronizing state of ${name} with SysV service script.`)
      for (const level of ['0', '1', '2', '3', '4', '5', '6']) {
        const dir = `/etc/rc${level}.d`
        for (const file of reader.readdir(dir)) if (file.slice(3) === script) removeLink(`${dir}/${file}`)
        // as update-rc.d disables: the start links become stop links
        if (['2', '3', '4', '5'].includes(level) && exists(`/etc/init.d/${script}`)) link(`../init.d/${script}`, `${dir}/K01${script}`)
      }
      continue
    }
    for (const target of wantedByLinks(reader, name)) removeLink(`/etc/systemd/system/${target}.wants/${name}`)
    for (const target of Object.keys(TARGETS)) removeLink(`/etc/systemd/system/${target}.requires/${name}`)
    for (const alias of unit?.alias ?? []) removeLink(`/etc/systemd/system/${alias}`)
  }
  return 0
}

function mask(names) {
  let status = 0
  for (const name of names) {
    const path = `/etc/systemd/system/${name}`
    if (exists(path) && reader.readlink(path) !== '/dev/null') { err(`Failed to mask unit: File ${path} already exists.`); status = 1; continue }
    link('/dev/null', path)
  }
  return status
}

function unmask(names) {
  for (const name of names) if (reader.readlink(`/etc/systemd/system/${name}`) === '/dev/null') removeLink(`/etc/systemd/system/${name}`)
  return 0
}

function editorFor() {
  for (const key of ['SYSTEMD_EDITOR', 'EDITOR', 'VISUAL']) {
    const words = (env[key] ?? '').trim().split(/\s+/).filter(Boolean)
    if (words.length) return words
  }
  for (const candidate of ['/bin/nano', '/bin/vim', '/bin/vi']) if (exists(candidate)) return [candidate]
  return undefined
}

async function edit(names, full) {
  if (!isRoot()) { err('Failed to edit: Access denied'); return 1 }
  const editor = editorFor()
  if (!editor) { err('Cannot edit units, no editor available. Please set either $SYSTEMD_EDITOR, $EDITOR or $VISUAL.'); return 1 }
  const all = units()
  for (const name of names) {
    const unit = all.get(name)
    if (!unit) { err(`No files found for ${name}.`); return 1 }
    let path
    if (full) {
      path = `/etc/systemd/system/${name}`
      if (!unit.path.startsWith('/etc/systemd/system/')) {
        const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        try { writeAll(fd, encoder.encode(reader.readFile(unit.path) ?? '')) } finally { close(fd) }
      }
    } else {
      const dir = `/etc/systemd/system/${name}.d`
      if (!exists(dir)) mkdir(dir, 0o755)
      path = `${dir}/override.conf`
      if (!exists(path)) {
        const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        try { writeAll(fd, encoder.encode(`### Editing ${path}\n### Anything between here and the comment below will become the contents of the drop-in file\n\n\n\n### Edits below this comment will be discarded\n`)) } finally { close(fd) }
      }
    }
    const pid = await spawn(editor[0], [...editor, path], { cwd: getcwd(), env: { ...env } })
    const done = await waitpid(pid, false)
    if (done.code !== 0) { err(`Editor exited with status ${done.code ?? 128 + done.signal}.`); return 1 }
    if (!full) {
      // what is below the marker is discarded, as systemctl does; a drop-in left empty is removed
      const text = reader.readFile(path) ?? ''
      const kept = text.split('### Edits below this comment will be discarded')[0].split('\n').filter(line => !line.startsWith('### ')).join('\n').trim()
      if (!kept) { unlink(path); err(`Editing "${path}" canceled: temporary file is empty.`); continue }
      const fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
      try { writeAll(fd, encoder.encode(kept + '\n')) } finally { close(fd) }
    }
  }
  if (readState() !== undefined) await ask('daemon-reload', [])
  return 0
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'ht:ap:P:qln:s:',
    long: {
      help: 'h', version: 'version', type: { key: 't', arg: 'required' }, state: { key: 'state', arg: 'required' }, failed: 'failed', all: 'a',
      property: { key: 'p', arg: 'required' }, value: 'value', quiet: 'q', now: 'now', 'no-pager': 'no-pager', 'no-legend': 'no-legend', plain: 'plain',
      full: 'l', lines: { key: 'n', arg: 'required' }, signal: { key: 's', arg: 'required' }, force: 'force', system: 'system', user: 'user', 'no-block': 'no-block', 'no-ask-password': 'no-ask-password'
    }
  })
  if (error) { err(`systemctl: ${error}`); err(tryHelp('systemctl')); return 1 }
  const opts = { all: false, legend: true, quiet: false, now: false, noPager: false, full: false, lines: 10, value: false, properties: [], signal: 15, force: false }
  for (const [key, value] of options) {
    if (key === 'h') { out(usage + '\n'); return 0 }
    if (key === 'version') { out('ecmaOS systemctl 1.0 (the service manager is /sbin/init, not systemd)\n'); return 0 }
    if (key === 't') opts.type = value
    else if (key === 'state') opts.state = value
    else if (key === 'failed') opts.state = 'failed'
    else if (key === 'a') opts.all = true
    else if (key === 'p') opts.properties.push(...value.split(','))
    else if (key === 'P') { opts.properties.push(value); opts.value = true }
    else if (key === 'value') opts.value = true
    else if (key === 'q') opts.quiet = true
    else if (key === 'now') opts.now = true
    else if (key === 'no-pager') opts.noPager = true
    else if (key === 'no-legend') opts.legend = false
    else if (key === 'l') opts.full = true
    else if (key === 'force') opts.force = true
    else if (key === 'user') { err('Failed to connect to bus: there is no user service manager here'); return 1 }
    else if (key === 'n') {
      if (!/^\d+$/.test(value)) { err(`Failed to parse lines '${value}'`); return 1 }
      opts.lines = Number(value)
    } else if (key === 's') {
      const name = value.toUpperCase().replace(/^SIG/, '')
      opts.signal = /^\d+$/.test(value) ? Number(value) : SIGNALS[name]
      if (!opts.signal) { err(`Failed to parse signal string ${value}.`); return 1 }
    }
  }
  const [command = 'list-units', ...rest] = operands
  const named = () => {
    if (rest.length === 0) { err(`Too few arguments.`); exit(1) }
    return expand(rest, [...units().keys(), ...Object.keys(TARGETS)])
  }

  switch (command) {
    case 'list-units':
      await show(listUnits(rest, opts), opts.quiet, opts.noPager)
      return 0
    case 'list-unit-files':
      await show(listUnitFiles(rest, opts), opts.quiet, opts.noPager)
      return 0
    case 'list-timers':
      if (opts.legend) out('NEXT LEFT LAST PASSED UNIT ACTIVATES\n\n0 timers listed.\nPass --all to see loaded but inactive timers, too.\n')
      return 0
    case 'status': {
      if (rest.length === 0) { await show(systemStatus(), opts.quiet, opts.noPager); return 0 }
      let code = 0
      const lines = []
      for (const name of named()) {
        const result = statusOf(name, opts)
        if (lines.length && result.lines.length) lines.push('')
        lines.push(...result.lines)
        code = Math.max(code, result.code)
      }
      await show(lines, opts.quiet, opts.noPager)
      return code
    }
    case 'is-active': case 'is-failed': {
      const state = readState() ?? {}
      let any = false
      for (const name of named()) {
        const s = name.endsWith('.target') ? targetState(name, readState()) : state[name]
        const active = s?.ActiveState ?? 'inactive'
        if (!opts.quiet) out(`${active}\n`)
        if (command === 'is-active' ? active === 'active' || active === 'reloading' : active === 'failed') any = true
      }
      return any ? 0 : command === 'is-active' ? 3 : 1
    }
    case 'is-enabled': {
      const all = units()
      let any = false
      for (const name of named()) {
        const state = enablement(reader, all.get(name), name)
        if (state === 'not-found') { err(`Failed to get unit file state for ${name}: No such file or directory`); continue }
        if (!opts.quiet) out(`${state}\n`)
        if (['enabled', 'static', 'alias'].includes(state)) any = true
      }
      return any ? 0 : 1
    }
    case 'is-system-running': {
      const state = readState()
      const status = state === undefined ? 'offline' : Object.values(state).some(s => s.ActiveState === 'failed') ? 'degraded' : 'running'
      if (!opts.quiet) out(`${status}\n`)
      return status === 'running' ? 0 : 1
    }
    case 'show': {
      const names = rest.length ? named() : []
      if (names.length === 0) {
        const lines = ['Version=ecmaOS', 'Architecture=wasm', `NFailedUnits=${Object.values(readState() ?? {}).filter(s => s.ActiveState === 'failed').length}`, 'SystemState=running', 'DefaultStandardOutput=journal']
        out(lines.filter(line => !opts.properties.length || opts.properties.includes(line.split('=')[0])).map(line => opts.value ? line.split('=').slice(1).join('=') : line).join('\n') + '\n')
        return 0
      }
      const blocks = names.map(name => {
        const props = properties(name)
        const keys = opts.properties.length ? opts.properties : PROPERTY_ORDER
        return keys.filter(key => key in props && (opts.all || opts.properties.length || props[key] !== '')).map(key => opts.value ? props[key] : `${key}=${props[key]}`).join('\n')
      })
      out(blocks.join('\n\n') + '\n')
      return 0
    }
    case 'cat': {
      const all = units()
      let code = 0
      const parts = []
      for (const name of named()) {
        const unit = all.get(name)
        if (!unit) { err(`No files found for ${name}.`); code = 1; continue }
        parts.push(`${paint('34', `# ${unit.path}`)}\n${reader.readFile(unit.path) ?? ''}`)
        for (const drop of dropIns(reader, name)) parts.push(`${paint('34', `# ${drop.path}`)}\n${drop.text}`)
      }
      await show(parts.join('\n').split('\n'), false, opts.noPager)
      return code
    }
    case 'start': case 'stop': case 'restart': case 'try-restart': case 'reload': case 'reload-or-restart': case 'kill': case 'condrestart': case 'force-reload': {
      const action = command === 'condrestart' ? 'try-restart' : command === 'force-reload' ? 'reload-or-restart' : command
      const names = named()
      const answer = await ask(action, names, action === 'kill' ? { signal: opts.signal } : {})
      if (answer.denied) return 4
      for (const message of answer.errors ?? []) err(message)
      return answer.ok ? 0 : 1
    }
    case 'reset-failed': {
      const answer = await ask('reset-failed', rest.length ? named() : Object.keys(readState() ?? {}))
      if (answer.denied) return 4
      return answer.ok ? 0 : 1
    }
    case 'enable': case 'disable': case 'reenable': case 'mask': case 'unmask': {
      if (!isRoot()) { err(`Failed to ${command} unit: Access denied`); return 4 }
      const names = named()
      let code = 0
      if (command === 'enable' || command === 'reenable') {
        if (command === 'reenable') disable(names)
        code = enable(names, opts.force)
      } else if (command === 'disable') code = disable(names)
      else if (command === 'mask') code = mask(names)
      else code = unmask(names)
      if (readState() !== undefined) await ask('daemon-reload', [])
      if (opts.now && (command === 'enable' || command === 'disable' || command === 'mask')) {
        const answer = await ask(command === 'enable' ? 'start' : 'stop', names)
        for (const message of answer.errors ?? []) err(message)
        if (!answer.ok) code = 1
      }
      return code
    }
    case 'edit': return await edit(named(), opts.full)
    case 'daemon-reload': case 'daemon-reexec': {
      const answer = await ask(command, [])
      if (answer.denied) return 4
      return answer.ok ? 0 : 1
    }
    case 'get-default': {
      const target = reader.readlink('/etc/systemd/system/default.target')
      out(`${target ? target.slice(target.lastIndexOf('/') + 1) : 'graphical.target'}\n`)
      return 0
    }
    case 'set-default': {
      if (!isRoot()) { err('Failed to set default target: Access denied'); return 4 }
      const target = rest[0]
      if (!target || !TARGETS[target] || target === 'default.target') { err(`Failed to set default target: Unit file ${target ?? ''} does not exist.`); return 1 }
      link(`/lib/systemd/system/${target}`, '/etc/systemd/system/default.target')
      return 0
    }
    case 'poweroff': case 'reboot': case 'halt': {
      const pid = await spawn(`/bin/${command}`, [command], { cwd: '/', env: { ...env } })
      const done = await waitpid(pid, false)
      return done.code ?? 1
    }
    case 'suspend': case 'hibernate': case 'hybrid-sleep':
      err(`Failed to ${command} system via logind: the browser decides when a page sleeps`)
      return 1
    default:
      err(`Unknown command verb '${command}'.`)
      return 1
  }
}

try {
  exit(await main())
} catch (error) {
  err(`systemctl: ${reasonOf(error)}`)
  exit(1)
}
