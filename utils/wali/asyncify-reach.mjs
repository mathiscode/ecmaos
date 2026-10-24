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
 * Usage: asyncify-reach.mjs <program.wasm> <function,function...>. The program needs its function names (wasm-ld leaves
 * them out of a program linked with -O2) and wasm-opt must be on the PATH.
 */
import { execFileSync } from 'node:child_process'

const [program, throughPointers = ''] = process.argv.slice(2)
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
let fork, current
for (const line of text.split('\n')) {
  let m
  if ((m = line.match(/^ \(type (\$\S+) (\(func.*\))\)$/))) types.set(m[1], signatureOf(m[2]))
  else if ((m = line.match(/^ \(import "wali" "SYS_fork" \(func (\$\S+)/))) fork = m[1]
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
if (fork === undefined) { console.error(`${program}: does not import wali.SYS_fork`); process.exit(1) }
for (const name of indirect) {
  if (!functions.has(name)) { console.error(`${program}: no function ${name.slice(1)} to follow the calls through a pointer of (a program linked with -O2 has no function names)`); process.exit(1) }
}

const reaches = new Set([fork])
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
reaches.delete(fork)
console.log([...reaches].map(name => name.slice(1)).join(','))
