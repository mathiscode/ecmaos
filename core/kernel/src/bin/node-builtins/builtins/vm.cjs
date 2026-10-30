/**
 * Node's `vm`, without contexts of its own: code runs in this realm. `runInNewContext` gives the code the context's
 * properties as variables and looks nothing else up through them, which is what most callers use it for (evaluating an
 * expression against some data); it is not a security boundary.
 */
const contexts = new WeakSet()

function evaluate(code, context, filename) {
  const names = Object.keys(context ?? {}).filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
  const body = `${String(code)}${filename ? `\n//# sourceURL=${filename}` : ''}`
  const run = new Function(...names, 'return eval(arguments[arguments.length - 1])')
  return run(...names.map(name => context[name]), body)
}

class Script {
  constructor(code, options = {}) {
    this.code = String(code)
    this.filename = typeof options === 'string' ? options : options.filename
    // a syntax error belongs to the constructor, as in Node
    new Function(`"use strict"; return async () => {\n${this.code}\n}`)
  }

  runInThisContext() { return (0, eval)(`${this.code}${this.filename ? `\n//# sourceURL=${this.filename}` : ''}`) }
  runInContext(context) { return evaluate(this.code, context, this.filename) }
  runInNewContext(context = {}) { return evaluate(this.code, context, this.filename) }
  createCachedData() { return new Uint8Array(0) }
}

module.exports = {
  Script,
  createContext: (context = {}) => { contexts.add(context); return context },
  isContext: context => contexts.has(context),
  runInThisContext: (code, options) => new Script(code, options).runInThisContext(),
  runInContext: (code, context, options) => new Script(code, options).runInContext(context),
  runInNewContext: (code, context, options) => new Script(code, options).runInNewContext(context),
  compileFunction: (code, params = [], options = {}) => new Function(...params, `${code}${options.filename ? `\n//# sourceURL=${options.filename}` : ''}`)
}
