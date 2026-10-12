/**
 * `/etc/sudoers`: who may run what as whom, read by `/bin/sudo`. A subset of the real grammar:
 *
 *     # comment
 *     Defaults timestamp_timeout=5
 *     Defaults !authenticate
 *     root    ALL=(ALL:ALL) ALL
 *     %sudo   ALL=(ALL:ALL) ALL
 *     alice   ALL=(root) NOPASSWD: /bin/ls, /bin/cat /etc/hosts
 *     bob     ALL=(root) /bin/ls, !/bin/rm, (alice) PASSWD: ALL
 *
 * Users are `ALL`, a name, `%group` or `#uid`. The host is `ALL` or this host's name. After `=` is a comma-separated
 * command list; `(runas)` and the `PASSWD:`/`NOPASSWD:` tags apply to everything after them until changed. A command
 * is `ALL` or an absolute path (a trailing `/` means every file in the directory, `*` matches anything), optionally
 * with the exact arguments allowed; `!` forbids it. The last matching rule decides.
 * Aliases: `User_Alias`, `Runas_Alias`, `Host_Alias`, `Cmnd_Alias`, several per line separated by `:`; they may nest,
 * be defined after use, and `!READ` forbids every command in an alias. Names are upper case.
 * Not supported (reported as a warning): `#include`, `#includedir`, `SETENV:`/`NOEXEC:`, and `Defaults` other than
 * the two above. A line that does not parse is skipped.
 */

export interface SudoCommandSpec {
  /** `ALL`, an absolute path, or a directory ending in `/` */
  command: string
  /** Exact arguments required, or undefined for any */
  args?: string
  negated: boolean
  runAs: string[]
  /** Whether the rule asks for no password */
  noPassword: boolean
}

export interface SudoRule {
  users: string[]
  hosts: string[]
  commands: SudoCommandSpec[]
}

export interface SudoDefaults {
  /** Minutes a password stays good for; 0 asks every time, a negative number never expires */
  timestampTimeout: number
  /** False (`Defaults !authenticate`) turns passwords off for every rule */
  authenticate: boolean
}

export interface SudoPolicy {
  rules: SudoRule[]
  defaults: SudoDefaults
  warnings: string[]
}

export interface SudoRequest {
  /** The user asking */
  user: string
  uid: number
  /** Names of the groups the user is in */
  groups: string[]
  gids: number[]
  host: string
  /** The user to run as */
  runAs: string
  /** Absolute path of the program */
  command: string
  args: string[]
}

export interface SudoDecision {
  allowed: boolean
  /** Whether the rule that allowed it asked for no password */
  noPassword: boolean
}

const TAGS = new Set(['PASSWD', 'NOPASSWD', 'SETENV', 'NOSETENV', 'EXEC', 'NOEXEC', 'LOG_INPUT', 'NOLOG_INPUT', 'LOG_OUTPUT', 'NOLOG_OUTPUT'])
const ALIAS_KINDS = { User_Alias: 'user', Runas_Alias: 'runas', Host_Alias: 'host', Cmnd_Alias: 'cmnd' } as const
const ALIAS_NAME = /^[A-Z][A-Z0-9_]*$/
const ALIAS_DEPTH = 16

type AliasKind = (typeof ALIAS_KINDS)[keyof typeof ALIAS_KINDS]
type Aliases = Record<AliasKind, Map<string, string[]>>

/**
 * Replaces each alias in `items` with what it stands for (an unknown name stays as it is, a user or host of that
 * name).
 */
function expandAliases(items: string[], maps: Map<string, string[]>[], depth = 0): string[] {
  if (depth > ALIAS_DEPTH) throw new Error('aliases are nested too deeply (a loop?)')
  return items.flatMap(item => {
    const members = ALIAS_NAME.test(item) && item !== 'ALL' ? maps.map(map => map.get(item)).find(found => found !== undefined) : undefined
    return members ? expandAliases(members, maps, depth + 1) : [item]
  })
}

/** Splits at commas that are outside parentheses, so `(a,b) /bin/ls, /bin/cat` is two entries. */
function splitList(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = '' } else current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(Boolean)
}

function parseCommands(text: string, aliases: Aliases, depth = 0): SudoCommandSpec[] {
  if (depth > ALIAS_DEPTH) throw new Error('aliases are nested too deeply (a loop?)')
  const specs: SudoCommandSpec[] = []
  let runAs = ['root']
  let noPassword = false
  for (let entry of splitList(text)) {
    for (;;) {
      const runAsMatch = /^\(([^)]*)\)\s*/.exec(entry)
      if (runAsMatch) {
        const [users] = (runAsMatch[1] ?? '').split(':')
        runAs = expandAliases((users ?? '').split(',').map(name => name.trim()).filter(Boolean), [aliases.runas, aliases.user])
        if (runAs.length === 0) runAs = ['root']
        entry = entry.slice(runAsMatch[0].length)
        continue
      }
      const tagMatch = /^([A-Z_]+):\s*/.exec(entry)
      if (tagMatch && TAGS.has(tagMatch[1] ?? '')) {
        if (tagMatch[1] === 'NOPASSWD') noPassword = true
        else if (tagMatch[1] === 'PASSWD') noPassword = false
        entry = entry.slice(tagMatch[0].length)
        continue
      }
      break
    }
    if (!entry) continue
    const negated = entry.startsWith('!')
    const body = (negated ? entry.slice(1) : entry).trim()
    const alias = ALIAS_NAME.test(body) && body !== 'ALL' ? aliases.cmnd.get(body) : undefined
    if (alias) {
      for (const spec of parseCommands(alias.join(', '), aliases, depth + 1)) specs.push({ ...spec, negated: negated !== spec.negated, runAs: [...runAs], noPassword })
      continue
    }
    const space = body.search(/\s/)
    const command = space === -1 ? body : body.slice(0, space)
    const args = space === -1 ? undefined : body.slice(space).trim()
    if (command !== 'ALL' && !command.startsWith('/')) throw new Error(`'${command}' is not an absolute path`)
    specs.push({ command, args: args === '""' ? '' : args, negated, runAs: [...runAs], noPassword })
  }
  return specs
}

export function parseSudoers(text: string): SudoPolicy {
  const policy: SudoPolicy = { rules: [], defaults: { timestampTimeout: 5, authenticate: true }, warnings: [] }
  // a line ending in a backslash continues on the next
  const lines = text.replace(/\\\r?\n/g, ' ').split('\n')
  const stripComment = (raw: string) => raw.replace(/(^|\s)#(?![0-9]).*$/, '').trim()
  // aliases first, so a rule may use one defined further down
  const aliases: Aliases = { user: new Map(), runas: new Map(), host: new Map(), cmnd: new Map() }
  const aliasLines = new Set<number>()
  lines.forEach((raw, index) => {
    const line = raw.trim().startsWith('#include') ? '' : stripComment(raw)
    const word = line.split(/\s+/)[0] ?? ''
    const kind = (ALIAS_KINDS as Record<string, AliasKind>)[word]
    if (!kind) return
    aliasLines.add(index)
    const warn = (message: string) => policy.warnings.push(`line ${index + 1}: ${message}`)
    for (const definition of line.slice(word.length).split(/\s*:\s*(?=[A-Z][A-Z0-9_]*\s*=)/)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/.exec(definition)
      if (!match) { warn(`expected "${word} NAME = members"`); continue }
      aliases[kind].set(match[1] ?? '', splitList(match[2] ?? ''))
    }
  })
  lines.forEach((raw, index) => {
    if (aliasLines.has(index)) return
    const warn = (message: string) => policy.warnings.push(`line ${index + 1}: ${message}`)
    // `#include` looks like a comment but is a directive; `#1000` is a uid, not a comment
    if (raw.trim().startsWith('#include')) return warn(`${raw.trim().split(/\s+/)[0]} is not supported`)
    const line = stripComment(raw)
    if (!line) return
    const word = line.split(/\s+/)[0] ?? ''
    if (word.startsWith('Defaults')) {
      if (word !== 'Defaults') return warn(`${word} is not supported`)
      for (const item of splitList(line.slice(word.length))) {
        const timeout = /^timestamp_timeout\s*=\s*(-?\d+(?:\.\d+)?)$/.exec(item)
        if (timeout) policy.defaults.timestampTimeout = Number(timeout[1])
        else if (item === 'authenticate') policy.defaults.authenticate = true
        else if (item === '!authenticate') policy.defaults.authenticate = false
        else warn(`Defaults ${item} is not supported`)
      }
      return
    }
    const equals = line.indexOf('=')
    const head = equals === -1 ? '' : line.slice(0, equals).trim()
    const headMatch = /^(.+?)\s+(\S+)$/.exec(head)
    if (!headMatch) return warn('expected "users host=(runas) commands"')
    try {
      const commands = parseCommands(line.slice(equals + 1), aliases)
      if (commands.length === 0) return warn('no commands')
      policy.rules.push({
        users: expandAliases((headMatch[1] ?? '').split(',').map(name => name.trim()).filter(Boolean), [aliases.user]),
        hosts: expandAliases((headMatch[2] ?? '').split(',').map(name => name.trim()).filter(Boolean), [aliases.host]),
        commands
      })
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error))
    }
  })
  return policy
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
}

function userMatches(rule: SudoRule, request: SudoRequest): boolean {
  return rule.users.some(entry => {
    if (entry === 'ALL') return true
    if (entry.startsWith('%#')) return request.gids.includes(Number(entry.slice(2)))
    if (entry.startsWith('%')) return request.groups.includes(entry.slice(1))
    if (entry.startsWith('#')) return request.uid === Number(entry.slice(1))
    return entry === request.user
  })
}

function hostMatches(rule: SudoRule, host: string): boolean {
  return rule.hosts.some(entry => entry === 'ALL' || entry.toLowerCase() === host.toLowerCase())
}

function commandMatches(spec: SudoCommandSpec, request: SudoRequest): boolean {
  if (!spec.runAs.includes('ALL') && !spec.runAs.includes(request.runAs)) return false
  if (spec.command === 'ALL') return true
  const pathMatches = spec.command.endsWith('/')
    ? request.command.startsWith(spec.command) && !request.command.slice(spec.command.length).includes('/')
    : globToRegExp(spec.command).test(request.command)
  if (!pathMatches) return false
  if (spec.args === undefined || spec.command.endsWith('/')) return true
  return globToRegExp(spec.args).test(request.args.join(' '))
}

/** What the rules say about `request`: the last rule that matches decides, and no match means no. */
export function checkSudo(policy: SudoPolicy, request: SudoRequest): SudoDecision {
  let decision: SudoDecision = { allowed: false, noPassword: false }
  for (const rule of policy.rules) {
    if (!userMatches(rule, request) || !hostMatches(rule, request.host)) continue
    for (const spec of rule.commands) {
      if (!commandMatches(spec, request)) continue
      decision = { allowed: !spec.negated, noPassword: !policy.defaults.authenticate || spec.noPassword }
    }
  }
  return decision
}

/** What `sudo -l` prints for a user: one line per command entry the user's rules grant or forbid. */
export function listPrivileges(policy: SudoPolicy, who: Pick<SudoRequest, 'user' | 'uid' | 'groups' | 'gids' | 'host'>): string[] {
  const lines: string[] = []
  for (const rule of policy.rules) {
    const request = { ...who, runAs: '', command: '', args: [] }
    if (!userMatches(rule, request) || !hostMatches(rule, who.host)) continue
    for (const spec of rule.commands) {
      const runAs = spec.runAs.join(', ')
      const tag = !policy.defaults.authenticate || spec.noPassword ? 'NOPASSWD: ' : ''
      const command = `${spec.negated ? '!' : ''}${spec.command}${spec.args ? ` ${spec.args}` : ''}`
      lines.push(`    (${runAs}) ${tag}${command}`)
    }
  }
  return lines
}

/** The file `/etc/sudoers` starts as: root may do anything, and so may anyone in the `sudo` group. */
export const DEFAULT_SUDOERS = `# /etc/sudoers: who may run what as whom (see sudoers(5) and sudo(1))
#
# Users are a name, %group, #uid or ALL. After the = comes (runas) and the commands, with
# optional NOPASSWD: and ! (forbid). The last matching rule wins.
Defaults timestamp_timeout=5

root    ALL=(ALL:ALL) ALL
%sudo   ALL=(ALL:ALL) ALL
`
