/** Print environment variables: all of them as NAME=VALUE, or just the values of those named. */

const { argv, env, exit, writeAll } = globalThis.ecmaosSyscalls

const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(text + '\n'))

const usage = `Usage: printenv [OPTION]... [NAME]...
Print the values of the named environment variables, or all of them as NAME=VALUE.

  -0, --null  end each line with NUL, not a newline
  --help      display this help and exit`

function main() {
  const args = argv.slice(1)
  let terminator = '\n'
  const names = []
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { err(usage); return 0 }
    if (arg === '-0' || arg === '--null') terminator = '\0'
    else if (arg.startsWith('-') && arg.length > 1) { err(`printenv: invalid option -- '${arg.replace(/^-+/, '')}'`); return 2 }
    else names.push(arg)
  }

  if (!names.length) {
    writeAll(1, encoder.encode(Object.entries(env).map(([name, value]) => `${name}=${value}${terminator}`).join('')))
    return 0
  }

  let status = 0
  for (const name of names) {
    if (Object.hasOwn(env, name)) writeAll(1, encoder.encode(env[name] + terminator))
    else status = 1
  }
  return status
}

try {
  exit(main())
} catch (error) {
  err(`printenv: ${error instanceof Error ? error.message : String(error)}`)
  exit(2)
}
