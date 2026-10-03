/**
 * `/etc/sudoers`: who may run what as whom, read by `/bin/sudo`.
 *
 * A deliberately small subset of the real grammar, enough for the files people actually write:
 *
 *     # comment
 *     Defaults timestamp_timeout=5
 *     Defaults !authenticate
 *     root    ALL=(ALL:ALL) ALL
 *     %sudo   ALL=(ALL:ALL) ALL
 *     alice   ALL=(root) NOPASSWD: /bin/ls, /bin/cat /etc/hosts
 *     bob     ALL=(root) /bin/ls, !/bin/rm, (alice) PASSWD: ALL
 *
 * Users are `ALL`, a name, `%group` or `#uid`, comma separated. The host must be `ALL` or this host's
 * name. After `=`, a comma-separated command list: `(runas)` and the `PASSWD:`/`NOPASSWD:` tags apply to
 * everything after them until changed, as in sudo. A command is `ALL`, an absolute path (a trailing `/`
 * means every file in that directory; `*` matches anything), optionally followed by the exact arguments
 * allowed, and `!` in front forbids it. The last rule that matches decides.
 *
 * Not supported, and reported as a warning rather than guessed at: aliases (`User_Alias` and the rest),
 * `#include`/`#includedir`, `Runas_Alias`, `SETENV:`/`NOEXEC:` tags, `Defaults` other than the two above.
 * A line that does not parse is skipped, never fatal, so one typo cannot lock everyone out.
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
const ALIAS_WORDS = new Set(['User_Alias', 'Runas_Alias', 'Host_Alias', 'Cmnd_Alias'])

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

function parseCommands(text: string): SudoCommandSpec[] {
  const specs: SudoCommandSpec[] = []
  let runAs = ['root']
  let noPassword = false
  for (let entry of splitList(text)) {
    for (;;) {
      const runAsMatch = /^\(([^)]*)\)\s*/.exec(entry)
      if (runAsMatch) {
        const [users] = (runAsMatch[1] ?? '').split(':')
        runAs = (users ?? '').split(',').map(name => name.trim()).filter(Boolean)
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
  lines.forEach((raw, index) => {
    const warn = (message: string) => policy.warnings.push(`line ${index + 1}: ${message}`)
    // `#include` looks like a comment but is a directive; `#1000` is a uid, not a comment
    if (raw.trim().startsWith('#include')) return warn(`${raw.trim().split(/\s+/)[0]} is not supported`)
    const line = raw.replace(/(^|\s)#(?![0-9]).*$/, '').trim()
    if (!line) return
    const word = line.split(/\s+/)[0] ?? ''
    if (ALIAS_WORDS.has(word)) return warn(`${word} is not supported`)
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
      const commands = parseCommands(line.slice(equals + 1))
      if (commands.length === 0) return warn('no commands')
      policy.rules.push({
        users: (headMatch[1] ?? '').split(',').map(name => name.trim()).filter(Boolean),
        hosts: (headMatch[2] ?? '').split(',').map(name => name.trim()).filter(Boolean),
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
