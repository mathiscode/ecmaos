/**
 * systemd unit files, as far as ecmaOS runs them: `.service` units in `/etc/systemd/system` (the administrator's) and
 * `/lib/systemd/system` (what packages ship), and the SysV scripts in `/etc/init.d`, which become `NAME.service` units
 * the way systemd's sysv-generator makes them. `/etc` wins over `/lib` for a name; a unit file wins over a script.
 * Enabling a unit is a link in `TARGET.wants/`; enabling a script is `S` links in `/etc/rc2.d` to `rc5.d` (and `K` links
 * in `rc0.d`, `rc1.d`, `rc6.d`), as `update-rc.d` makes them. Drop-ins (`NAME.d/*.conf` in either directory) are read
 * after the unit's file, in name order, as if they were its end.
 * The parsing is the file format's: sections, `Key=Value`, `#` and `;` comments, a trailing `\` continuing the line, a
 * key given again adding to a list (and an empty value clearing it). Nothing here touches the filesystem: the callers pass
 * what they read. No Node built-ins.
 */

export const UNIT_DIRS = ['/etc/systemd/system', '/lib/systemd/system'] as const
export const INIT_D = '/etc/init.d'

/** The targets there are; a unit is enabled by being wanted by one of them */
export const TARGETS: Record<string, string> = {
  'multi-user.target': 'Multi-User System',
  'graphical.target': 'Graphical Interface',
  'default.target': 'Graphical Interface',
  'sysinit.target': 'System Initialization',
  'basic.target': 'Basic System',
  'network.target': 'Network',
  'network-online.target': 'Network is Online',
  'timers.target': 'Timer Units',
  'shutdown.target': 'System Shutdown'
}

/** The SysV runlevels a target stands for, as systemd maps them */
export const RUNLEVEL_TARGETS: Record<string, string> = {
  '0': 'poweroff.target', '1': 'rescue.target', '2': 'multi-user.target', '3': 'multi-user.target', '4': 'multi-user.target', '5': 'graphical.target', '6': 'reboot.target'
}

export type Sections = Record<string, Record<string, string[]>>

export function parseUnitText(text: string): Sections {
  const sections: Sections = {}
  let current: Record<string, string[]> | undefined
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\r$/, '')
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1).trimEnd() + ' ' + lines[++i]!.replace(/\r$/, '').trimStart()
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const section = /^\[([^\]]+)\]$/.exec(trimmed)
    if (section) { current = sections[section[1]!] ??= {}; continue }
    const eq = trimmed.indexOf('=')
    if (eq === -1 || !current) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (value === '') current[key] = []
    else (current[key] ??= []).push(value)
  }
  return sections
}

/**
 * A command line's words, as systemd splits `ExecStart=`: double and single quotes, backslash escapes, and `$NAME` and
 * `${NAME}` from the unit's environment (`${NAME}` is one word, `$NAME` splits on spaces).
 */
export function splitCommand(text: string, env: Record<string, string> = {}): string[] {
  const words: string[] = []
  let word = ''
  let started = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\' && i + 1 < text.length) { word += text[++i]; started = true; continue }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1)
      const inner = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end)
      word += c === '"' ? inner.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '') : inner
      started = true
      i = end === -1 ? text.length : end
      continue
    }
    if (c === '$') {
      const braced = /^\$\{(\w+)\}/.exec(text.slice(i))
      const bare = /^\$(\w+)/.exec(text.slice(i))
      if (braced) { word += env[braced[1]!] ?? ''; started = true; i += braced[0].length - 1; continue }
      if (bare) {
        const parts = (env[bare[1]!] ?? '').split(/\s+/).filter(Boolean)
        if (parts.length) {
          word += parts[0]
          for (const part of parts.slice(1)) { words.push(word); word = part }
          started = true
        }
        i += bare[0].length - 1
        continue
      }
    }
    if (/\s/.test(c)) {
      if (started) { words.push(word); word = ''; started = false }
      continue
    }
    word += c
    started = true
  }
  if (started) words.push(word)
  return words
}

/** `Environment=` values: `A=1 "B=two words"` */
export function parseEnvironment(values: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const value of values) {
    for (const pair of splitCommand(value)) {
      const eq = pair.indexOf('=')
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
  }
  return env
}

/** An `EnvironmentFile=`: `NAME=value` lines, quotes taken off, comments skipped */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return env
}

/** One `Exec*=` line: its words, and whether a failure is ignored (the `-` prefix) */
export interface ExecLine { line: string, ignoreFailure: boolean }

function execLines(values: string[] | undefined): ExecLine[] {
  return (values ?? []).map(value => {
    let line = value
    let ignoreFailure = false
    // `-` ignores a failure; `@`, `+`, `!` and `:` change what systemd hands the process, which here is the same
    while (/^[-@+!:]/.test(line)) { if (line[0] === '-') ignoreFailure = true; line = line.slice(1) }
    return { line: line.trim(), ignoreFailure }
  })
}

export type ServiceType = 'simple' | 'exec' | 'oneshot' | 'forking' | 'notify' | 'idle'
export type RestartPolicy = 'no' | 'always' | 'on-success' | 'on-failure' | 'on-abnormal' | 'on-abort' | 'on-watchdog'

export interface Unit {
  name: string
  /** The file it was read from; a script for a SysV unit */
  path: string
  sysv: boolean
  description: string
  documentation: string[]
  after: string[]
  before: string[]
  wants: string[]
  requires: string[]
  conflicts: string[]
  type: ServiceType
  execStartPre: ExecLine[]
  execStart: ExecLine[]
  execStartPost: ExecLine[]
  execStop: ExecLine[]
  execStopPost: ExecLine[]
  execReload: ExecLine[]
  restart: RestartPolicy
  /** ms */
  restartSec: number
  /** ms */
  timeoutStopSec: number
  remainAfterExit: boolean
  user?: string
  group?: string
  workingDirectory?: string
  environment: Record<string, string>
  environmentFiles: { path: string, optional: boolean }[]
  pidFile?: string
  killSignal: number
  syslogIdentifier?: string
  standardOutput: 'journal' | 'null' | 'inherit'
  wantedBy: string[]
  requiredBy: string[]
  alias: string[]
  /** Problems with the file, as systemd logs them; the unit still loads when it can */
  warnings: string[]
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15, SIGCONT: 18, SIGSTOP: 19 }

/** `90`, `90s`, `5min`, `1min 30s`, `500ms`, `infinity` as milliseconds; undefined when malformed */
export function parseTimespan(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === 'infinity') return Infinity
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
  const units: Record<string, number> = { us: 0.001, usec: 0.001, ms: 1, msec: 1, s: 1000, sec: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, minute: 60000, minutes: 60000, h: 3600000, hr: 3600000, hour: 3600000, hours: 3600000, d: 86400000, day: 86400000, days: 86400000 }
  let total = 0
  let rest = trimmed
  while (rest) {
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)\s*/.exec(rest)
    if (!match || match[0] === '') return undefined
    const factor = match[2] ? units[match[2]] : 1000
    if (factor === undefined) return undefined
    total += Number(match[1]) * factor
    rest = rest.slice(match[0].length)
  }
  return total
}

const words = (values: string[] | undefined) => (values ?? []).flatMap(value => value.split(/\s+/)).filter(Boolean)
const last = (values: string[] | undefined) => values?.[values.length - 1]
const yes = (value: string | undefined) => /^(1|yes|true|on)$/i.test(value ?? '')

/** A `.service` file's unit */
export function serviceFromText(name: string, path: string, text: string): Unit {
  const sections = parseUnitText(text)
  const unit = sections['Unit'] ?? {}
  const service = sections['Service'] ?? {}
  const install = sections['Install'] ?? {}
  const warnings: string[] = []
  const execStart = execLines(service['ExecStart'])
  let type = (last(service['Type']) ?? (execStart.length ? 'simple' : 'oneshot')) as ServiceType
  if (!['simple', 'exec', 'oneshot', 'forking', 'notify', 'idle'].includes(type)) { warnings.push(`Failed to parse service type, ignoring: ${type}`); type = 'simple' }
  if (execStart.length > 1 && type !== 'oneshot') warnings.push('Service has more than one ExecStart= setting, which is only allowed for Type=oneshot services. Refusing.')
  if (execStart.length === 0 && type !== 'oneshot') warnings.push('Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.')
  let restart = (last(service['Restart']) ?? 'no') as RestartPolicy
  if (!['no', 'always', 'on-success', 'on-failure', 'on-abnormal', 'on-abort', 'on-watchdog'].includes(restart)) { warnings.push(`Failed to parse service restart specifier, ignoring: ${restart}`); restart = 'no' }
  const killSignalName = last(service['KillSignal'])
  const killSignal = killSignalName === undefined ? 15 : SIGNALS[killSignalName.toUpperCase().replace(/^(?!SIG)/, 'SIG')] ?? (Number(killSignalName) || 15)
  const output = last(service['StandardOutput'])
  return {
    name,
    path,
    sysv: false,
    description: last(unit['Description']) ?? name,
    documentation: words(unit['Documentation']),
    after: words(unit['After']),
    before: words(unit['Before']),
    wants: words(unit['Wants']),
    requires: words(unit['Requires']),
    conflicts: words(unit['Conflicts']),
    type,
    execStartPre: execLines(service['ExecStartPre']),
    execStart,
    execStartPost: execLines(service['ExecStartPost']),
    execStop: execLines(service['ExecStop']),
    execStopPost: execLines(service['ExecStopPost']),
    execReload: execLines(service['ExecReload']),
    restart,
    restartSec: parseTimespan(last(service['RestartSec']) ?? '100ms') ?? 100,
    timeoutStopSec: parseTimespan(last(service['TimeoutStopSec']) ?? last(service['TimeoutSec']) ?? '10s') ?? 10000,
    remainAfterExit: yes(last(service['RemainAfterExit'])),
    user: last(service['User']),
    group: last(service['Group']),
    workingDirectory: last(service['WorkingDirectory']),
    environment: parseEnvironment(service['Environment'] ?? []),
    environmentFiles: (service['EnvironmentFile'] ?? []).map(value => value.startsWith('-') ? { path: value.slice(1), optional: true } : { path: value, optional: false }),
    pidFile: last(service['PIDFile']),
    killSignal,
    syslogIdentifier: last(service['SyslogIdentifier']),
    standardOutput: output === 'null' ? 'null' : output === 'inherit' || output === 'tty' ? 'inherit' : 'journal',
    wantedBy: words(install['WantedBy']),
    requiredBy: words(install['RequiredBy']),
    alias: words(install['Alias']),
    warnings
  }
}

/** The LSB header's `# Key: value` lines of a SysV script */
function lsbHeader(text: string): Record<string, string> {
  const header: Record<string, string> = {}
  const start = text.indexOf('### BEGIN INIT INFO')
  const end = text.indexOf('### END INIT INFO')
  if (start === -1 || end === -1) return header
  for (const line of text.slice(start, end).split('\n')) {
    const match = /^#\s*([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (match) header[match[1]!] = match[2]!.trim()
  }
  return header
}

/** A SysV script as a unit: started with `SCRIPT start` and stopped with `SCRIPT stop`, active once it has started */
export function serviceFromScript(name: string, path: string, text: string): Unit {
  const header = lsbHeader(text)
  return {
    ...serviceFromText(`${name}.service`, path, ''),
    sysv: true,
    description: header['Short-Description'] ? `LSB: ${header['Short-Description']}` : `${name}.service`,
    documentation: ['man:systemd-sysv-generator(8)'],
    type: 'forking',
    execStart: [{ line: `${path} start`, ignoreFailure: false }],
    execStop: [{ line: `${path} stop`, ignoreFailure: false }],
    execReload: [{ line: `${path} reload`, ignoreFailure: false }],
    remainAfterExit: true,
    timeoutStopSec: 300000,
    wantedBy: [],
    warnings: []
  }
}

/** `foo` is `foo.service`; a name with a known suffix is kept */
export function unitName(text: string): string {
  return /\.(service|target|socket|timer|mount|path|slice|scope|device|swap)$/.test(text) ? text : `${text}.service`
}

/** What a reader of the unit directories needs, so this file stays free of the filesystem */
export interface UnitReader {
  readdir(path: string): string[]
  readFile(path: string): string | undefined
  /** Where a link points, or undefined when `path` is not one */
  readlink(path: string): string | undefined
  isExecutable(path: string): boolean
}

/** Every unit there is, by name: files in the unit directories, then the scripts that no file shadows */
export function loadUnits(reader: UnitReader): Map<string, Unit> {
  const units = new Map<string, Unit>()
  const masked = new Set<string>()
  for (const dir of UNIT_DIRS) {
    for (const file of reader.readdir(dir)) {
      if (!file.endsWith('.service') || units.has(file) || masked.has(file)) continue
      const path = `${dir}/${file}`
      const target = reader.readlink(path)
      // `/dev/null` is a masked unit, whatever another directory has of that name
      if (target === '/dev/null') { masked.add(file); continue }
      const text = reader.readFile(path)
      if (text !== undefined) units.set(file, serviceFromText(file, path, text + dropIns(reader, file).map(drop => '\n' + drop.text).join('')))
    }
  }
  for (const file of reader.readdir(INIT_D)) {
    const name = `${file}.service`
    const path = `${INIT_D}/${file}`
    if (units.has(name) || masked.has(name) || file.startsWith('.') || file === 'README' || file === 'rc' || file === 'rcS' || !reader.isExecutable(path)) continue
    const text = reader.readFile(path)
    if (text !== undefined) units.set(name, serviceFromScript(file, path, text))
  }
  return units
}

/** A unit's drop-in files, `/lib` ones first, then `/etc`, each directory's in name order */
export function dropIns(reader: UnitReader, name: string): { path: string, text: string }[] {
  const found: { path: string, text: string }[] = []
  for (const dir of [...UNIT_DIRS].reverse()) {
    for (const file of reader.readdir(`${dir}/${name}.d`).filter(entry => entry.endsWith('.conf')).sort()) {
      const text = reader.readFile(`${dir}/${name}.d/${file}`)
      if (text !== undefined) found.push({ path: `${dir}/${name}.d/${file}`, text })
    }
  }
  return found
}

/** Whether a name is masked: a link to `/dev/null` in `/etc/systemd/system` */
export function isMasked(reader: UnitReader, name: string): boolean {
  return reader.readlink(`/etc/systemd/system/${name}`) === '/dev/null'
}

/** The targets whose `.wants/` holds a link to the unit */
export function wantedByLinks(reader: UnitReader, name: string): string[] {
  const found: string[] = []
  for (const target of Object.keys(TARGETS)) {
    if (reader.readlink(`/etc/systemd/system/${target}.wants/${name}`) !== undefined) found.push(target)
  }
  return found
}

/** Whether a SysV script has a start link in the runlevel's `rcN.d` */
export function sysvEnabledIn(reader: UnitReader, script: string, level: string): boolean {
  return reader.readdir(`/etc/rc${level}.d`).some(file => /^S\d\d/.test(file) && file.slice(3) === script)
}

/** `enabled`, `disabled`, `static` (nothing to enable it by), `masked`, or `not-found` */
export function enablement(reader: UnitReader, unit: Unit | undefined, name: string): string {
  if (isMasked(reader, name)) return 'masked'
  if (!unit) return name.endsWith('.target') ? 'static' : 'not-found'
  if (unit.sysv) return ['2', '3', '4', '5'].some(level => sysvEnabledIn(reader, name.replace(/\.service$/, ''), level)) ? 'enabled' : 'disabled'
  if (wantedByLinks(reader, name).length) return 'enabled'
  if (unit.wantedBy.length === 0 && unit.requiredBy.length === 0 && unit.alias.length === 0) return 'static'
  return 'disabled'
}

/** Orders units so that each comes after the ones it is `After=` (and before the ones it is `Before=`) */
export function startOrder(units: Unit[]): Unit[] {
  const byName = new Map(units.map(unit => [unit.name, unit]))
  const deps = new Map<string, Set<string>>(units.map(unit => [unit.name, new Set(unit.after.filter(name => byName.has(name)))]))
  for (const unit of units) for (const name of unit.before) deps.get(name)?.add(unit.name)
  const ordered: Unit[] = []
  const seen = new Set<string>()
  const visit = (name: string, path: Set<string>) => {
    if (seen.has(name) || path.has(name)) return
    path.add(name)
    for (const dep of deps.get(name) ?? []) visit(dep, path)
    path.delete(name)
    seen.add(name)
    ordered.push(byName.get(name)!)
  }
  for (const unit of units) visit(unit.name, new Set())
  return ordered
}

/** What init publishes in `/run/systemd/state.json` about each unit it has run, and `systemctl` reads */
export interface UnitState {
  ActiveState: 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed' | 'reloading'
  SubState: string
  /** The process init started for `ExecStart=`: for a unit whose output goes to the journal, `systemd-cat`, whose child is the program */
  MainPID: number
  /** ms since the epoch */
  ActiveEnterTimestamp?: number
  InactiveEnterTimestamp?: number
  ExecMainStartTimestamp?: number
  ExecMainExitTimestamp?: number
  /** `exited` or `killed` */
  ExecMainCode?: string
  ExecMainStatus?: number
  Result: string
  NRestarts: number
  /** The `ExecStart=` command line, for `status` */
  ExecMain?: string
}

export const STATE_FILE = '/run/systemd/state.json'
export const RUN_DIR = '/run/systemd'
