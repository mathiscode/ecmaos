/** Node's `util`, from the `util` package, with what a modern CLI reaches for */
const util = require('@polyfill/util')

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g
const STYLES = { reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29], black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39], gray: [90, 39], grey: [90, 39] }

/** `util.parseArgs`, for the options CLIs declare: strings and booleans, short and long, with `=`, positionals and `--` */
function parseArgs({ args = process.argv.slice(2), options = {}, strict = true, allowPositionals = !strict, tokens = false } = {}) {
  const values = { __proto__: null }
  const positionals = []
  const found = []
  const shortToLong = {}
  for (const [name, option] of Object.entries(options)) if (option.short) shortToLong[option.short] = name
  const set = (name, value, token) => {
    const option = options[name]
    if (!option) {
      if (strict) throw Object.assign(new TypeError(`Unknown option '${token}'`), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' })
      values[name] = value ?? true
      return
    }
    if (option.type === 'string' && typeof value !== 'string') throw Object.assign(new TypeError(`Option '${token}' argument missing`), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' })
    if (option.type === 'boolean' && typeof value === 'string') throw Object.assign(new TypeError(`Option '${token}' does not take an argument`), { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' })
    if (option.multiple) (values[name] ??= []).push(value ?? true)
    else values[name] = value ?? true
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = arg.slice(2, equals < 0 ? undefined : equals)
      const inline = equals < 0 ? undefined : arg.slice(equals + 1)
      const option = options[name]
      let value = inline
      if (value === undefined && option?.type === 'string') value = args[++i]
      found.push({ kind: 'option', name, value, rawName: `--${name}`, index: i })
      set(name, value, `--${name}`)
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const name = shortToLong[arg[j]] ?? arg[j]
        const option = options[name]
        let value
        if (option?.type === 'string') { value = arg.slice(j + 1) || args[++i]; j = arg.length }
        found.push({ kind: 'option', name, value, rawName: `-${arg[j]}`, index: i })
        set(name, value, `-${arg[j]}`)
      }
    } else if (allowPositionals) {
      positionals.push(arg)
      found.push({ kind: 'positional', value: arg, index: i })
    } else {
      throw Object.assign(new TypeError(`Unexpected argument '${arg}'. This command does not take positional arguments`), { code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' })
    }
  }
  for (const [name, option] of Object.entries(options)) if (values[name] === undefined && option.default !== undefined) values[name] = option.default
  return { values, positionals, ...(tokens ? { tokens: found } : {}) }
}

module.exports = {
  ...util,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  parseArgs,
  stripVTControlCharacters: text => String(text).replace(ANSI, ''),
  styleText: (format, text) => [].concat(format).reduce((out, name) => (STYLES[name] ? `\u001b[${STYLES[name][0]}m${out}\u001b[${STYLES[name][1]}m` : out), String(text)),
  toUSVString: text => String(text).toWellFormed(),
  isDeepStrictEqual: (a, b) => { try { require('node:assert').deepStrictEqual(a, b); return true } catch { return false } },
  getSystemErrorName: code => ({ '-2': 'ENOENT', '-13': 'EACCES', '-17': 'EEXIST', '-20': 'ENOTDIR', '-21': 'EISDIR', '-22': 'EINVAL', '-32': 'EPIPE' })[code]
}
module.exports.promisify = util.promisify
