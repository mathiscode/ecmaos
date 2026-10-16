/**
 * `test` and `[`, as bash evaluates them: a count of arguments decides the form up to four (so `[ ! -f x ]`, `[ -f ]`
 * and `[ ( x ) ]` keep their POSIX meaning), and longer lists go through a precedence parse of `!`, `-a`, `-o` and
 * parentheses. File tests read the real status of a file (its type, mode bits, owner, links and times) and judge
 * read, write and execute access for the effective user, as the kernel would.
 */

/** What a file test needs to know about a file; `undefined` from {@link TestHost.fileInfo} means it does not exist. */
export interface TestFileInfo {
  mode: number
  uid: number
  gid: number
  dev: number
  ino: number
  size: number
  atimeMs: number
  mtimeMs: number
}

export interface TestHost {
  resolvePath(path: string): string
  /** Status of a file, following symlinks unless `follow` is false. */
  fileInfo(path: string, follow: boolean): Promise<TestFileInfo | undefined>
  /** The effective user and group of the shell; a host without one tests as root. */
  identity?(): { uid: number, gid: number, groups: number[] }
  /** Whether a file descriptor is a terminal (`-t`). */
  isTerminal?(fd: number): boolean
  /** Whether a shell option is on (`-o`): `undefined` for a name that is no option. */
  optionOn?(name: string): boolean | undefined
  /** Whether a variable is set (`-v`), including `name[index]` for arrays. */
  variableSet?(name: string): boolean
}

const S_IFMT = 0xf000
const kinds = { socket: 0xc000, link: 0xa000, regular: 0x8000, block: 0x6000, dir: 0x4000, char: 0x2000, fifo: 0x1000 }

const UNARY = new Set([
  '-a', '-b', '-c', '-d', '-e', '-f', '-g', '-G', '-h', '-k', '-L', '-N', '-O', '-p', '-r', '-s', '-S', '-t', '-u', '-w', '-x',
  '-n', '-z', '-o', '-v'
])
const INTEGER = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
const BINARY = new Set(['=', '==', '!=', '<', '>', '-nt', '-ot', '-ef', ...INTEGER])

/** Thrown for a malformed expression: the status is 2 and the message follows `test: ` */
export class TestError extends Error {}

function integer(text: string): number {
  const trimmed = text.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) throw new TestError(`${text}: integer expression expected`)
  return Number(trimmed)
}

function accessible(info: TestFileInfo, who: { uid: number, gid: number, groups: number[] }, bit: 4 | 2 | 1): boolean {
  if (who.uid === 0) return bit !== 1 || (info.mode & S_IFMT) === kinds.dir || (info.mode & 0o111) !== 0
  if (info.uid === who.uid) return (info.mode & (bit << 6)) !== 0
  if (info.gid === who.gid || who.groups.includes(info.gid)) return (info.mode & (bit << 3)) !== 0
  return (info.mode & bit) !== 0
}

async function unary(host: TestHost, operator: string, operand: string): Promise<boolean> {
  switch (operator) {
    case '-n': return operand !== ''
    case '-z': return operand === ''
    case '-t': {
      if (!/^\d+$/.test(operand.trim())) throw new TestError(`${operand}: integer expression expected`)
      return host.isTerminal?.(Number(operand)) === true
    }
    case '-o': return host.optionOn?.(operand) === true
    case '-v': return host.variableSet?.(operand) === true
  }
  const path = host.resolvePath(operand)
  const info = await host.fileInfo(path, operator !== '-L' && operator !== '-h')
  if (!info) return false
  const kind = info.mode & S_IFMT
  const who = host.identity?.() ?? { uid: 0, gid: 0, groups: [] }
  switch (operator) {
    case '-a': case '-e': return true
    case '-f': return kind === kinds.regular
    case '-d': return kind === kinds.dir
    case '-b': return kind === kinds.block
    case '-c': return kind === kinds.char
    case '-p': return kind === kinds.fifo
    case '-S': return kind === kinds.socket
    case '-L': case '-h': return kind === kinds.link
    case '-s': return info.size > 0
    case '-g': return (info.mode & 0o2000) !== 0
    case '-u': return (info.mode & 0o4000) !== 0
    case '-k': return (info.mode & 0o1000) !== 0
    case '-r': return accessible(info, who, 4)
    case '-w': return accessible(info, who, 2)
    case '-x': return accessible(info, who, 1)
    case '-O': return info.uid === who.uid
    case '-G': return info.gid === who.gid
    case '-N': return info.mtimeMs > info.atimeMs
  }
  throw new TestError(`${operator}: unary operator expected`)
}

async function binary(host: TestHost, left: string, operator: string, right: string): Promise<boolean> {
  switch (operator) {
    case '=': case '==': return left === right
    case '!=': return left !== right
    case '<': return left < right
    case '>': return left > right
    case '-eq': return integer(left) === integer(right)
    case '-ne': return integer(left) !== integer(right)
    case '-lt': return integer(left) < integer(right)
    case '-le': return integer(left) <= integer(right)
    case '-gt': return integer(left) > integer(right)
    case '-ge': return integer(left) >= integer(right)
  }
  const a = await host.fileInfo(host.resolvePath(left), true)
  const b = await host.fileInfo(host.resolvePath(right), true)
  switch (operator) {
    case '-nt': return a !== undefined && (b === undefined || a.mtimeMs > b.mtimeMs)
    case '-ot': return b !== undefined && (a === undefined || a.mtimeMs < b.mtimeMs)
    case '-ef': return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino
  }
  throw new TestError(`${operator}: binary operator expected`)
}

/** The value of `test WORDS...`; throws {@link TestError} for a malformed expression. */
export async function evaluateTest(host: TestHost, words: string[]): Promise<boolean> {
  // The argument-count rules come first, since they settle things the general grammar would read differently
  const small = async (list: string[]): Promise<boolean | undefined> => {
    switch (list.length) {
      case 0: return false
      case 1: return list[0] !== ''
      case 2:
        if (list[0] === '!') return list[1] === ''
        if (UNARY.has(list[0] as string)) return await unary(host, list[0] as string, list[1] as string)
        throw new TestError('unary operator expected')
      case 3:
        if (BINARY.has(list[1] as string)) return await binary(host, list[0] as string, list[1] as string, list[2] as string)
        if (list[1] === '-a') return list[0] !== '' && list[2] !== ''
        if (list[1] === '-o') return list[0] !== '' || list[2] !== ''
        if (list[0] === '!') return !(await small(list.slice(1)))
        if (list[0] === '(' && list[2] === ')') return list[1] !== ''
        throw new TestError('binary operator expected')
      case 4:
        if (list[0] === '!') return !(await small(list.slice(1)))
        if (list[0] === '(' && list[3] === ')') return await small(list.slice(1, 3))
        return undefined
      default: return undefined
    }
  }
  const quick = await small(words)
  if (quick !== undefined) return quick

  let position = 0
  const peek = () => words[position]

  const primary = async (): Promise<boolean> => {
    const word = peek()
    if (word === undefined) throw new TestError('argument expected')
    if (word === '(') {
      position++
      const value = await orExpression()
      if (peek() !== ')') throw new TestError("`)' expected")
      position++
      return value
    }
    if (word === '!') { position++; return !await primary() }
    const next = words[position + 1]
    const after = words[position + 2]
    // A binary operator in the middle wins over a unary reading of the first word
    if (next !== undefined && after !== undefined && BINARY.has(next)) {
      position += 3
      return await binary(host, word, next, after)
    }
    if (UNARY.has(word) && next !== undefined && !(next === '-a' || next === '-o') ) {
      position += 2
      return await unary(host, word, next)
    }
    position++
    return word !== ''
  }

  const andExpression = async (): Promise<boolean> => {
    let value = await primary()
    while (peek() === '-a') { position++; const rhs = await primary(); value = value && rhs }
    return value
  }

  const orExpression = async (): Promise<boolean> => {
    let value = await andExpression()
    while (peek() === '-o') { position++; const rhs = await andExpression(); value = value || rhs }
    return value
  }

  const value = await orExpression()
  if (position < words.length) throw new TestError('too many arguments')
  return value
}
