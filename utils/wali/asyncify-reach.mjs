#!/usr/bin/env node
/**
 * Prints the functions of a linked WALI program that can reach `wali.SYS_fork`, by name, comma separated: what
 * asyncify.sh hands Asyncify as the only functions to rewrite, when a port says where its calls through a pointer reach
 * fork.
 *
 * Binaryen takes a call through a pointer to reach whatever any function in the table does, so a program that forks
 * anywhere has every function that calls through a pointer rewritten, and every caller of those: dash grew by half and
 * ran a shell loop 40 to 65% slower (two measurements). Most of those calls cannot reach fork (a comparison function, a stdio write), and the
 * port knows which can (dash runs its builtins through a pointer, and `eval` and `.` among them run commands). This
 * follows the direct calls, and the calls through a pointer of only the functions it is told of: such a call reaches a
 * table entry of its type (the engine traps on any other) that reaches fork. A function it does not name cannot be on
 * the stack when fork is called, so it needs nothing saved. If the port misses one, the child of a fork under that call
 * traps when it rewinds; the table is what the program's element segments put in it.
 *
 * Usage: asyncify-reach.mjs <program.wasm> <function,function...> [import,import... | all]. The program needs its function
 * names (wasm-ld leaves them out of a program linked with -O2) and wasm-opt must be on the PATH. Imports named in the
 * third argument (`SYS_tgkill`, `__ecmaos_poll`) are reached like fork is: the program is to unwind at them too, for a
 * signal handler that forks (the host runs handlers where an import returns; `ECMAOS_WALI_ASYNCIFY_SIGNALS` in
 * asyncify.sh). `all` is every wali import the program has but those that do not return.
 *
 * Also: `asyncify-reach.mjs --imports <program.wasm>` prints those imports, comma separated, and
 * `asyncify-reach.mjs --mark <program.wasm> <import,import...>` adds them to the program as its `ecmaos.asyncify-signals`
 * section, which tells the host where a handler's fork can unwind.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/** The wali imports that never return to a program, which no handler is delivered after */
const ENDS = new Set(['SYS_fork', 'SYS_vfork', 'SYS_exit', 'SYS_exit_group', '__proc_exit', 'SYS_execve', 'SYS_rt_sigreturn'])
const SECTION = 'ecmaos.asyncify-signals'

if (process.argv[2] === '--mark') {
  const [, , , file, names] = process.argv
  const uleb = n => { const out = []; do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte) } while (n); return out }
  const name = Buffer.from(SECTION), payload = Buffer.from(names)
  const body = Buffer.concat([Buffer.from(uleb(name.length)), name, payload])
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0, ...uleb(body.length)]), body]))
  process.exit(0)
}

const imports = process.argv[2] === '--imports'
const [program, throughPointers = '', extraImports = ''] = imports ? process.argv.slice(3) : process.argv.slice(2)
const indirect = new Set(throughPointers.split(',').filter(Boolean).map(name => `$${name}`))
const text = execFileSync('wasm-opt', [
  program, '--print', '--enable-threads', '--enable-bulk-memory', '--enable-sign-ext', '--enable-mutable-globals',
  '--enable-nontrapping-float-to-int', '--enable-multivalue', '--enable-reference-types', '--enable-exception-handling'
], { encoding: 'utf8', maxBuffer: 1 << 30 })

/** A function type as its parameter and result types, which a call_indirect's type and a function's own share */
const signatureOf = text => {
  const params = [...text.matchAll(/\(param ([^)]*)\)/g)].flatMap(m => m[1].split(' ').filter(t => /^(i32|i64|f32|f64|v128|\S*ref)/.test(t)))
  const results = [...text.matchAll(/\(result ([^)]*)\)/g)].flatMap(m => m[1].split(' '))
  return `${params.join(' ')}->${results.join(' ')}`
}
const types = new Map()
const table = new Set()
const functions = new Map()
const signatures = new Map()
const waliImports = new Map()
let fork, current
for (const line of text.split('\n')) {
  let m
  if ((m = line.match(/^ \(type (\$\S+) (\(func.*\))\)$/))) types.set(m[1], signatureOf(m[2]))
  else if ((m = line.match(/^ \(import "wali" "(\S+)" \(func (\$\S+)/))) {
    waliImports.set(m[1], m[2])
    if (m[1] === 'SYS_fork') fork = m[2]
  }
  else if ((m = line.match(/^ \(elem \S+ \([^)]*\) (.*)\)$/))) m[1].split(' ').forEach(name => table.add(name))
  else if ((m = line.match(/^ \(func (\$\S+)(.*)$/))) {
    functions.set(m[1], current = { direct: new Set(), indirect: new Set() })
    const type = m[2].match(/^ \(type (\$[^\s)]+)\)/)
    signatures.set(m[1], type ? types.get(type[1]) : signatureOf(m[2]))
  } else if (current && line.startsWith(' (')) current = undefined
  else if (current) {
    for (const [, callee] of line.matchAll(/\((?:return_)?call (\$[^\s)]+)/g)) current.direct.add(callee)
    for (const [, type] of line.matchAll(/\((?:return_)?call_indirect \S+ \(type (\$[^\s)]+)\)/g)) current.indirect.add(types.get(type))
  }
}
if (imports) {
  console.log([...waliImports.keys()].filter(name => !ENDS.has(name)).join(','))
  process.exit(0)
}
if (fork === undefined) { console.error(`${program}: does not import wali.SYS_fork`); process.exit(1) }
const seeds = extraImports === 'all' ? [...waliImports.keys()].filter(name => !ENDS.has(name)) : extraImports.split(',').filter(Boolean)
for (const name of seeds) {
  if (!waliImports.has(name)) { console.error(`${program}: does not import wali.${name}`); process.exit(1) }
}
for (const name of indirect) {
  if (!functions.has(name)) { console.error(`${program}: no function ${name.slice(1)} to follow the calls through a pointer of (a program linked with -O2 has no function names)`); process.exit(1) }
}

const reaches = new Set([fork, ...seeds.map(name => waliImports.get(name))])
const reachedTypes = new Set()
for (let changed = true; changed;) {
  changed = false
  for (const [name, calls] of functions) {
    if (reaches.has(name)) continue
    if ([...calls.direct].some(callee => reaches.has(callee)) || (indirect.has(name) && [...calls.indirect].some(type => reachedTypes.has(type)))) {
      reaches.add(name)
      changed = true
      if (table.has(name)) reachedTypes.add(signatures.get(name))
    }
  }
}
for (const name of [fork, ...seeds.map(name => waliImports.get(name))]) reaches.delete(name)
console.log([...reaches].map(name => name.slice(1)).join(','))
