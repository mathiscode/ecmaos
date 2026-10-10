/**
 * What `help` knows about each builtin: its synopsis and a short description. The table is the one source,
 * and a test keeps it covering every name the shells implement, so a new builtin cannot be left out of `help`.
 */

export interface HelpTopic {
  /** The usage line, as `help -s` prints it. */
  synopsis: string
  /** One sentence, as `help -d` prints it. */
  summary: string
}

const topics: Record<string, HelpTopic> = {
  ':': { synopsis: ':', summary: 'Null command: does nothing and succeeds.' },
  '.': { synopsis: '. FILENAME [ARGUMENTS]', summary: 'Execute commands from a file in the current shell.' },
  '[': { synopsis: '[ ARG... ]', summary: 'Evaluate a conditional expression (the last argument must be `]`).' },
  alias: { synopsis: 'alias [-p] [NAME[=VALUE] ... ]', summary: 'Define or display aliases.' },
  bg: { synopsis: 'bg [JOB_SPEC ...]', summary: 'Move jobs to the background.' },
  break: { synopsis: 'break [N]', summary: 'Exit for, while, or until loops.' },
  caller: { synopsis: 'caller [EXPR]', summary: 'Return the context of the current subroutine call.' },
  cd: { synopsis: 'cd [DIR]', summary: 'Change the shell working directory.' },
  command: { synopsis: 'command [-v|-V] COMMAND [ARG ...]', summary: 'Execute a simple command or display information about commands.' },
  compgen: { synopsis: 'compgen [-abcdefgjksuv] [-o OPTION] [-A ACTION] [-G GLOBPAT] [-W WORDLIST] [-P PREFIX] [-S SUFFIX] [-X FILTERPAT] [WORD]', summary: 'Display possible completions depending on the options.' },
  complete: { synopsis: 'complete [-abcdefgjksuv] [-pr] [-DEI] [-o OPTION] [-A ACTION] [-G GLOBPAT] [-W WORDLIST] [-F FUNCTION] [-C COMMAND] [-X FILTERPAT] [-P PREFIX] [-S SUFFIX] [NAME ...]', summary: 'Specify how arguments are to be completed.' },
  compopt: { synopsis: 'compopt [-o|+o OPTION] [-DEI] [NAME ...]', summary: 'Modify or display completion options.' },
  continue: { synopsis: 'continue [N]', summary: 'Resume for, while, or until loops.' },
  declare: { synopsis: 'declare [-aAirx] [NAME[=VALUE] ...]', summary: 'Set variable values and attributes.' },
  dirs: { synopsis: 'dirs [-clpv] [+N] [-N]', summary: 'Display the list of currently remembered directories.' },
  disown: { synopsis: 'disown [-ar] [JOB_SPEC ...]', summary: 'Remove jobs from the current shell.' },
  echo: { synopsis: 'echo [-neE] [ARG ...]', summary: 'Write arguments to the standard output.' },
  eval: { synopsis: 'eval [ARG ...]', summary: 'Execute arguments as a shell command.' },
  exec: { synopsis: 'exec [COMMAND [ARGUMENT ...]] [REDIRECTION ...]', summary: 'Replace the shell with the given command, or apply redirections to the shell.' },
  exit: { synopsis: 'exit [N]', summary: 'Exit the shell.' },
  export: { synopsis: 'export [-n] [NAME[=VALUE] ...] or export -p', summary: 'Set export attribute for shell variables.' },
  false: { synopsis: 'false', summary: 'Return an unsuccessful result.' },
  fc: { synopsis: 'fc [-e ENAME] [-lnr] [FIRST] [LAST] or fc -s [PAT=REP] [COMMAND]', summary: 'Display or execute commands from the history list.' },
  fg: { synopsis: 'fg [JOB_SPEC]', summary: 'Move a job to the foreground.' },
  getopts: { synopsis: 'getopts OPTSTRING NAME [ARG ...]', summary: 'Parse option arguments.' },
  hash: { synopsis: 'hash [-lr] [-p PATHNAME] [-dt] [NAME ...]', summary: 'Remember or display program locations.' },
  help: { synopsis: 'help [-dms] [PATTERN ...]', summary: 'Display information about builtin commands.' },
  jobs: { synopsis: 'jobs [-lnprs] [JOBSPEC ...]', summary: 'Display status of jobs.' },
  let: { synopsis: 'let ARG [ARG ...]', summary: 'Evaluate arithmetic expressions.' },
  local: { synopsis: 'local [NAME[=VALUE] ...]', summary: 'Define local variables.' },
  logout: { synopsis: 'logout [N]', summary: 'Exit a login shell.' },
  mapfile: { synopsis: 'mapfile [-t] [-n COUNT] [-s COUNT] [-d DELIM] [-O ORIGIN] [ARRAY]', summary: 'Read lines from the standard input into an indexed array variable.' },
  popd: { synopsis: 'popd [-n] [+N | -N]', summary: 'Remove directories from stack.' },
  printf: { synopsis: 'printf [-v VAR] FORMAT [ARGUMENTS]', summary: 'Formats and prints ARGUMENTS under control of the FORMAT.' },
  pushd: { synopsis: 'pushd [-n] [+N | -N | DIR]', summary: 'Add directories to stack.' },
  pwd: { synopsis: 'pwd [-LP]', summary: 'Print the name of the current working directory.' },
  read: { synopsis: 'read [-ers] [-a ARRAY] [-d DELIM] [-n NCHARS] [-N NCHARS] [-p PROMPT] [-t TIMEOUT] [NAME ...]', summary: 'Read a line from the standard input and split it into fields.' },
  readarray: { synopsis: 'readarray [-t] [-n COUNT] [-s COUNT] [-d DELIM] [-O ORIGIN] [ARRAY]', summary: 'Read lines from a file into an array variable.' },
  readonly: { synopsis: 'readonly [-p] [NAME[=VALUE] ...]', summary: 'Mark shell variables as unchangeable.' },
  return: { synopsis: 'return [N]', summary: 'Return from a shell function.' },
  select: { synopsis: 'select NAME [in WORDS ... ;] do COMMANDS; done', summary: 'Select words from a list and execute commands.' },
  set: { synopsis: 'set [-/+eufCvx] [-/+o OPTION-NAME] [--] [ARG ...]', summary: 'Set or unset values of shell options and positional parameters.' },
  shift: { synopsis: 'shift [N]', summary: 'Shift positional parameters.' },
  shopt: { synopsis: 'shopt [-pqsu] [OPTNAME ...]', summary: 'Set and unset shell options.' },
  source: { synopsis: 'source FILENAME [ARGUMENTS]', summary: 'Execute commands from a file in the current shell.' },
  test: { synopsis: 'test [EXPR]', summary: 'Evaluate conditional expression.' },
  times: { synopsis: 'times', summary: 'Display process times (not available: a browser has no CPU accounting).' },
  trap: { synopsis: 'trap [-lp] [[ARG] SIGNAL_SPEC ...]', summary: 'Trap signals and other events.' },
  true: { synopsis: 'true', summary: 'Return a successful result.' },
  type: { synopsis: 'type [-tp] NAME [NAME ...]', summary: 'Display information about command type.' },
  typeset: { synopsis: 'typeset [-aAirx] [NAME[=VALUE] ...]', summary: 'Set variable values and attributes.' },
  ulimit: { synopsis: 'ulimit [-SHabcdefiklmnpqrstuvxPRT] [LIMIT]', summary: 'Show resource limits (only the real ones can be set: see `ulimit --help`).' },
  umask: { synopsis: 'umask [-p] [-S] [MODE]', summary: 'Display or set file mode mask.' },
  unalias: { synopsis: 'unalias [-a] NAME [NAME ...]', summary: 'Remove each NAME from the list of defined aliases.' },
  unset: { synopsis: 'unset [-f] [-v] [NAME ...]', summary: 'Unset values and attributes of shell variables and functions.' },
  wait: { synopsis: 'wait [-n] [ID ...]', summary: 'Wait for job completion and return exit status.' },
}

/** Every builtin `help` can describe, sorted. */
export const helpTopicNames: readonly string[] = Object.keys(topics).sort()

export function helpTopic(name: string): HelpTopic | undefined {
  return Object.prototype.hasOwnProperty.call(topics, name) ? topics[name] : undefined
}

/** A glob over topic names: `*`, `?` and `[...]`, as `help 'p*'` takes it. */
function patternMatcher(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end === -1) source += '\\['
      else { source += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end }
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** The topics a pattern selects: an exact name, or a glob. */
export function matchHelpTopics(pattern: string): string[] {
  if (helpTopic(pattern)) return [pattern]
  const matcher = patternMatcher(pattern)
  return helpTopicNames.filter(name => matcher.test(name))
}

/** `help` with no arguments: every synopsis, in two columns. */
export function helpOverview(): string {
  const width = 38
  const names = helpTopicNames
  const rows = Math.ceil(names.length / 2)
  const cell = (name: string | undefined) => name === undefined ? '' : ` ${(topics[name] as HelpTopic).synopsis}`.slice(0, width - 1)
  let out = ''
  for (let row = 0; row < rows; row++) {
    const left = cell(names[row])
    const right = cell(names[row + rows])
    out += right ? `${left.padEnd(width)}${right}\n` : `${left}\n`
  }
  return out
}
