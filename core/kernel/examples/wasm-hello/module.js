// A kernel module in JavaScript, built into a WebAssembly component: node scripts/wasm-module.mjs build examples/wasm-hello/module.js examples/wasm-hello/module.json wasm_hello.ko.wasm
import { log, proc, sys, debugfsFile, syscall, syscallPolicy, binfmt } from 'ecmaos:module/kernel@0.1.0'

let reads = 0
let note = ''
let greeting = 'hello'

export const lifecycle = {
  init(params) {
    greeting = new Map(params).get('greeting') ?? 'hello'
    log('info', `loaded; greeting is ${greeting}`)
    const failures = [
      proc('wasm_hello', true),
      sys('wasm_hello', [['greeting', false], ['note', true]]),
      debugfsFile('reads', false),
      syscall('wasm_hello_add'),
      syscallPolicy(),
      binfmt('hello', '/bin/sh')
    ].filter(code => code !== 0)
    if (failures.length) throw `could not add everything (error ${failures.join(', ')})`
  },
  exit() {
    log('info', 'unloading')
  }
}

export const hooks = {
  procShow: () => `${greeting} from WebAssembly\nnote: ${note}\n`,
  procStore: (_path, value) => { note = value.trim() },
  sysShow: (_path, attribute) => (attribute === 'greeting' ? greeting : note) + '\n',
  sysStore: (_path, _attribute, value) => { note = value.trim() },
  debugfsRead: () => `${++reads}\n`,
  debugfsWrite: () => {},
  syscallCall: (_name, _pid, _uid, _gid, args) => args.reduce((sum, arg) => sum + (arg.tag === 'number' ? arg.val : 0), 0),
  // refuses nothing but a syscall of its own, to show a policy
  syscallAllowed: syscall => syscall !== 'wasm_hello_refused',
  binfmtMatches: (_name, _filename, magic) => new TextDecoder().decode(magic.subarray(0, 6)) === 'HELLO:'
}
