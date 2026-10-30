/**
 * What `pip` needs of Python's packaging standards: PEP 440 versions and specifiers, PEP 508 requirements and their
 * environment markers, PEP 503 names. Small, and checked against the cases real packages use.
 */

/** PEP 503: the name as indexes and `dist-info` directories spell it */
export const normalize = name => String(name).toLowerCase().replace(/[-_.]+/g, '-')

const VERSION = /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d*))?(?:[-_.]?(dev)[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i

/** `{ epoch, release, pre, post, dev, local }` of a PEP 440 version, or `undefined` when it is not one */
export function parseVersion(text) {
  const match = VERSION.exec(String(text).toLowerCase())
  if (!match) return undefined
  const [, epoch, release, preTag, preNumber, postImplicit, postTag, postNumber, devTag, devNumber, local] = match
  const tag = { alpha: 'a', beta: 'b', c: 'rc', pre: 'rc', preview: 'rc' }[preTag] ?? preTag
  return {
    epoch: Number(epoch ?? 0),
    release: release.split('.').map(Number),
    pre: tag ? [tag, Number(preNumber || 0)] : undefined,
    post: postImplicit !== undefined ? Number(postImplicit) : (postTag ? Number(postNumber || 0) : undefined),
    dev: devTag ? Number(devNumber || 0) : undefined,
    local: local ? local.split(/[-_.]/).map(part => (/^\d+$/.test(part) ? Number(part) : part)) : undefined
  }
}

const PRE_ORDER = { a: 0, b: 1, rc: 2 }

function trimmed(release) {
  const copy = [...release]
  while (copy.length > 1 && copy[copy.length - 1] === 0) copy.pop()
  return copy
}

/** Sorts like PEP 440: negative when `a` is before `b` */
export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (left.epoch !== right.epoch) return left.epoch - right.epoch
  const x = trimmed(left.release)
  const y = trimmed(right.release)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const delta = (x[i] ?? 0) - (y[i] ?? 0)
    if (delta) return delta
  }
  // a dev release of 1.0 comes before its pre-releases, and a pre-release before the release
  const key = version => {
    const pre = version.pre ? PRE_ORDER[version.pre[0]] : (version.post === undefined && version.dev !== undefined ? -2 : 3)
    return [pre, version.pre?.[1] ?? 0, version.post ?? -1, version.dev ?? Infinity]
  }
  const p = key(left)
  const q = key(right)
  for (let i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1
  if (left.local || right.local) {
    const l = left.local ?? []
    const r = right.local ?? []
    for (let i = 0; i < Math.max(l.length, r.length); i++) {
      if (l[i] === undefined) return -1
      if (r[i] === undefined) return 1
      if (l[i] === r[i]) continue
      if (typeof l[i] === typeof r[i]) return l[i] < r[i] ? -1 : 1
      return typeof l[i] === 'number' ? 1 : -1
    }
  }
  return 0
}

export const isPrerelease = text => { const version = parseVersion(text); return Boolean(version?.pre || version?.dev !== undefined) }

const CLAUSE = /^\s*(===|==|!=|~=|<=|>=|<|>)\s*([^\s,]+)\s*$/

/** Whether `version` meets one clause (`>=1.2`, `==1.*`, `~=1.4.2`); a clause that is not one throws */
function meets(version, operator, wanted) {
  const v = parseVersion(version)
  if (operator === '===') return String(version).toLowerCase() === wanted.toLowerCase()
  if (wanted.endsWith('.*')) {
    const prefix = parseVersion(wanted.slice(0, -2))
    if (!prefix) throw new Error(`Invalid specifier: ${operator}${wanted}`)
    const same = v.epoch === prefix.epoch && prefix.release.every((part, index) => (v.release[index] ?? 0) === part)
    return operator === '==' ? same : !same
  }
  const w = parseVersion(wanted)
  if (!w) throw new Error(`Invalid specifier: ${operator}${wanted}`)
  // a specifier without a local part matches the version's public part
  const publicOf = value => ({ ...value, local: undefined })
  const compared = w.local ? compareVersions(v, w) : compareVersions(publicOf(v), w)
  switch (operator) {
    case '==': return compared === 0
    case '!=': return compared !== 0
    case '<=': return compared <= 0
    case '>=': return compared >= 0
    case '<': return compared < 0 && !(isPrereleaseOf(w, v))
    case '>': return compared > 0 && !(v.post !== undefined && w.post === undefined && sameRelease(v, w))
    case '~=': {
      if (w.release.length < 2) throw new Error(`Invalid specifier: ~=${wanted}`)
      const upper = { ...w, release: [...w.release.slice(0, -2), w.release[w.release.length - 2] + 1], pre: undefined, post: undefined, dev: undefined, local: undefined }
      return compareVersions(publicOf(v), w) >= 0 && compareVersions(publicOf(v), upper) < 0
    }
  }
  throw new Error(`Invalid operator ${operator}`)
}

const sameRelease = (a, b) => compareVersions({ ...a, pre: undefined, post: undefined, dev: undefined, local: undefined }, { ...b, pre: undefined, post: undefined, dev: undefined, local: undefined }) === 0
// `<1.0` does not take 1.0's own pre-releases
const isPrereleaseOf = (limit, v) => (v.pre || v.dev !== undefined) && !limit.pre && limit.dev === undefined && sameRelease(v, limit)

/** A specifier set (`>=1.0,<2`) as a list of `[operator, version]`; an empty text takes any version */
export function parseSpecifier(text) {
  const clauses = []
  for (const part of String(text ?? '').replace(/^\(|\)$/g, '').split(',')) {
    if (!part.trim()) continue
    const match = CLAUSE.exec(part)
    if (!match) throw new Error(`Invalid specifier: '${part.trim()}'`)
    clauses.push([match[1], match[2]])
  }
  return clauses
}

/**
 * Whether `version` meets `specifier`. Pre-releases are left out unless the specifier names one or `prereleases` is set,
 * as pip does.
 */
export function satisfies(version, specifier, { prereleases = false } = {}) {
  const clauses = typeof specifier === 'string' ? parseSpecifier(specifier) : specifier
  if (!parseVersion(version)) return false
  if (isPrerelease(version) && !prereleases && !clauses.some(([, wanted]) => isPrerelease(wanted.replace(/\.\*$/, '')))) return false
  return clauses.every(([operator, wanted]) => meets(version, operator, wanted))
}

// Markers

/** The environment markers are evaluated against: ecmaOS's CPython is a WALI build, so Linux to itself */
export function environment(pythonVersion = '3.14.0', extra = '') {
  const [major, minor] = pythonVersion.split('.')
  return {
    os_name: 'posix',
    sys_platform: 'linux',
    platform_machine: 'wasm32',
    platform_python_implementation: 'CPython',
    platform_release: '',
    platform_system: 'Linux',
    platform_version: '',
    python_version: `${major}.${minor}`,
    python_full_version: pythonVersion,
    implementation_name: 'cpython',
    implementation_version: pythonVersion,
    extra
  }
}

function tokenizeMarker(text) {
  const tokens = []
  const pattern = /\s*(?:(\()|(\))|(===|==|!=|~=|<=|>=|<|>)|(and|or|not|in)\b|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([a-z_][a-z0-9_.]*))/gy
  let match
  let end = 0
  while (end < text.length && (match = pattern.exec(text))) {
    end = pattern.lastIndex
    if (match[1] || match[2]) tokens.push({ type: match[0].trim() })
    else if (match[3]) tokens.push({ type: 'op', value: match[3] })
    else if (match[4]) tokens.push({ type: match[4] })
    else if (match[5]) tokens.push({ type: 'string', value: match[5].slice(1, -1) })
    else if (match[6]) tokens.push({ type: 'variable', value: match[6] })
    if (/^\s*$/.test(text.slice(end))) break
  }
  if (!/^\s*$/.test(text.slice(end))) throw new Error(`Invalid marker: ${text}`)
  return tokens
}

/** Evaluates a PEP 508 marker (`python_version >= "3.8" and extra == "test"`) against `env` */
export function evaluateMarker(text, env) {
  const tokens = tokenizeMarker(text)
  let at = 0
  const peek = () => tokens[at]
  const take = type => { if (peek()?.type !== type) throw new Error(`Invalid marker: ${text}`); return tokens[at++] }
  const value = () => {
    const token = tokens[at++]
    if (token?.type === 'string') return { text: token.value }
    if (token?.type === 'variable') {
      const key = token.value.replace(/^python_implementation$/, 'platform_python_implementation').replace(/^extra$/, 'extra')
      if (!(key in env)) throw new Error(`Invalid marker variable: ${token.value}`)
      return { text: env[key], variable: key }
    }
    throw new Error(`Invalid marker: ${text}`)
  }
  const compare = () => {
    if (peek()?.type === '(') { at++; const result = or(); take(')'); return result }
    const left = value()
    let operator = tokens[at++]
    if (operator?.type === 'not') { take('in'); operator = { type: 'not in' } }
    else if (operator?.type === 'op') operator = { type: operator.value }
    if (!operator || !['in', 'not in', '===', '==', '!=', '~=', '<=', '>=', '<', '>'].includes(operator.type)) throw new Error(`Invalid marker: ${text}`)
    const right = value()
    if (operator.type === 'in') return right.text.includes(left.text)
    if (operator.type === 'not in') return !right.text.includes(left.text)
    // version comparison when both sides parse as versions and one is a version variable, else plain strings
    const versionVariable = ['python_version', 'python_full_version', 'implementation_version', 'platform_release'].includes(left.variable) || ['python_version', 'python_full_version', 'implementation_version'].includes(right.variable)
    if (versionVariable && parseVersion(left.text) && (parseVersion(right.text) || /\.\*$/.test(right.text))) {
      return meets(left.text, operator.type, right.text)
    }
    const l = left.variable === 'extra' ? normalize(left.text) : left.text
    const r = right.variable === 'extra' || left.variable === 'extra' ? normalize(right.text) : right.text
    switch (operator.type) {
      case '==': case '===': return l === r
      case '!=': return l !== r
      case '<': return l < r
      case '<=': return l <= r
      case '>': return l > r
      case '>=': return l >= r
      case '~=': return l === r
    }
    return false
  }
  const and = () => { let result = compare(); while (peek()?.type === 'and') { at++; const next = compare(); result = result && next } return result }
  const or = () => { let result = and(); while (peek()?.type === 'or') { at++; const next = and(); result = result || next } return result }
  const result = or()
  if (at !== tokens.length) throw new Error(`Invalid marker: ${text}`)
  return result
}

// Requirements

const NAME = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?'
const REQUIREMENT = new RegExp(`^\\s*(${NAME})\\s*(?:\\[([^\\]]*)\\])?\\s*(\\([^)]*\\)|[^;@(\\s][^;@]*)?\\s*(?:@\\s*(\\S+))?\\s*(?:;(.*))?$`)

/** `{ name, extras, specifier, url, marker }` of a PEP 508 requirement (`requests[socks]>=2.0 ; python_version >= "3.8"`) */
export function parseRequirement(text) {
  const match = REQUIREMENT.exec(String(text).trim())
  if (!match) throw new Error(`Invalid requirement: '${String(text).trim()}'`)
  const [, name, extras, specifier, url, marker] = match
  return {
    name: normalize(name),
    extras: (extras ?? '').split(',').map(item => normalize(item.trim())).filter(Boolean),
    specifier: parseSpecifier(specifier ?? ''),
    url,
    marker: marker?.trim() || undefined
  }
}

/** Whether a requirement applies in `env` for the requesting package's `extras` */
export function applies(requirement, env, extras = ['']) {
  if (!requirement.marker) return true
  return extras.some(extra => evaluateMarker(requirement.marker, { ...env, extra }))
}

export const formatSpecifier = clauses => clauses.map(([operator, wanted]) => `${operator}${wanted}`).join(',')
