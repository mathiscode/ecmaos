/** Node's `module`: `createRequire`, `builtinModules` and `isBuiltin` over the loader that is running the program */
const loader = globalThis[Symbol.for('ecmaos.loader')]
const builtinModules = ['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'constants', 'events', 'fs', 'fs/promises', 'module', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'stream', 'stream/promises', 'string_decoder', 'timers', 'timers/promises', 'tty', 'url', 'util', 'util/types']

function Module() {}
Module.createRequire = filename => loader.createRequire(String(filename))
Module.builtinModules = builtinModules
Module.isBuiltin = name => builtinModules.includes(String(name).replace(/^node:/, ''))
Module.Module = Module
Module.syncBuiltinESMExports = () => {}
Module.register = () => {}
module.exports = Module
