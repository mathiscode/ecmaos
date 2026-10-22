#!/usr/bin/env node
/**
 * Puts a signal check at the top of every loop of a linked WALI program, so a signal reaches a program that is busy
 * computing: Linux interrupts it wherever it is, but a WebAssembly thread can only be ended from outside, not
 * interrupted, and the host runs handlers when an import returns. Each loop reads a word the kernel sets as it raises
 * a signal on one of the process's threads (or stops it), and when it is set calls the import `wali.__ecmaos_poll`,
 * whose return delivers what is pending, as any import's does. The word is at a fixed address, so a loop reads it
 * with one load (a global holding a thread's own address costs a tight loop up to a fifth of its speed, against a few
 * percent): address 8, at the bottom of the main thread's stack, which wali-cc lays out first (the program exports
 * the address as `__ecmaos_signal_word`, for the host).
 *
 * The stack pointer (global 0, as wasm-ld lays a program out) is lowered by 128 bytes around the call: LLVM lets a
 * leaf function keep up to that much below it without moving it (a red zone), which a handler would overwrite. The
 * program exports it as `__ecmaos_stack_pointer`, so the host can run a handler on an alternate stack (`sigaltstack`).
 *
 * The program is rewritten in place, in binary: the import is added after the others, so every function the program
 * defines moves up one, and each reference to one (calls, `ref.func`, the element segments, exports, start, the name
 * section) follows. DWARF's sections, whose code offsets move, are dropped.
 *
 * Usage: signal-checks.mjs <program.wasm>. WALI's wali-cc and wali-c++ run it on each program they link.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const RED_ZONE = 128, WORD = 8
/** The main thread's stack, which wali-cc puts first in memory, so global 0, the stack pointer, starts at its size */
const STACK_SIZE = 8388608
const POLL_MODULE = 'wali', POLL_NAME = '__ecmaos_poll', WORD_EXPORT = '__ecmaos_signal_word', STACK_POINTER_EXPORT = '__ecmaos_stack_pointer'

// --- encoding ---

class Reader {
  constructor(bytes, at = 0) { this.bytes = bytes; this.at = at }
  byte() { return this.bytes[this.at++] }
  u32() {
    let result = 0, shift = 0, byte
    do { byte = this.bytes[this.at++]; result |= (byte & 0x7f) << shift; shift += 7 } while (byte & 0x80)
    return result >>> 0
  }
  s32() {
    let result = 0, shift = 0, byte
    do { byte = this.bytes[this.at++]; result |= (byte & 0x7f) << shift; shift += 7 } while (byte & 0x80)
    return shift < 32 && (byte & 0x40) ? result | (-1 << shift) : result
  }
  /** Any LEB128, signed or not, of any width: only skipped */
  skipLeb() { while (this.bytes[this.at++] & 0x80);}
  skip(n) { this.at += n }
  name() { const length = this.u32(); const text = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + length)); this.at += length; return text }
}

const u32 = value => {
  const out = []
  do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte) } while (value)
  return out
}
const s32 = value => {
  const out = []
  for (;;) {
    const byte = value & 0x7f
    value >>= 7
    if ((value === 0 && !(byte & 0x40)) || (value === -1 && (byte & 0x40))) { out.push(byte); return out }
    out.push(byte | 0x80)
  }
}
const name = text => { const bytes = new TextEncoder().encode(text); return [...u32(bytes.length), ...bytes] }
const vector = items => [...u32(items.length), ...items.flat()]

// --- instructions ---

/** A block type: empty (0x40), a value type, or a type index (an s33) */
function skipBlockType(r) {
  const byte = r.bytes[r.at]
  if (byte === 0x40 || (byte >= 0x69 && byte <= 0x7f)) return r.skip(1)
  if (byte === 0x63 || byte === 0x64) { r.skip(1); return r.skipLeb() }
  r.skipLeb()
}
function skipValType(r) {
  const byte = r.byte()
  if (byte === 0x63 || byte === 0x64) r.skipLeb()
}
function skipMemarg(r) {
  const align = r.u32()
  if (align & 0x40) r.u32()
  r.skipLeb()
}

/**
 * Copies an expression (a function's body or a constant expression), renumbering function indices with `fn` and,
 * when `atLoop` is given, adding what it returns after each loop's header. Stops after the `end` that closes it.
 */
function copyExpression(r, out, fn, atLoop) {
  let depth = 1, from = r.at
  const flush = () => { for (let i = from; i < r.at; i++) out.push(r.bytes[i]) }
  const funcref = () => { flush(); out.push(...u32(fn(r.u32()))); from = r.at }
  while (depth) {
    const op = r.byte()
    switch (op) {
      case 0x02: case 0x04: case 0x06: skipBlockType(r); depth++; break
      case 0x03: skipBlockType(r); depth++; if (atLoop) { flush(); out.push(...atLoop()); from = r.at } break
      case 0x1f: { // try_table
        skipBlockType(r); depth++
        for (let n = r.u32(); n--;) { const kind = r.byte(); if (kind < 2) r.u32(); r.u32() }
        break
      }
      case 0x0b: depth--; break
      case 0x18: r.u32(); depth--; break // delegate ends its try
      case 0x05: case 0x19: case 0x00: case 0x01: case 0x0f: case 0x1a: case 0x1b: case 0x0a: case 0xd1: case 0xd3: case 0xd5: break
      case 0x07: case 0x08: case 0x09: case 0x0c: case 0x0d: case 0xd4: case 0xd6: r.u32(); break
      case 0x0e: for (let n = r.u32() + 1; n--;) r.u32(); break
      case 0x10: case 0x12: case 0xd2: funcref(); break
      case 0x11: case 0x13: r.u32(); r.u32(); break
      case 0x14: case 0x15: r.u32(); break
      case 0x1c: for (let n = r.u32(); n--;) skipValType(r); break
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: r.u32(); break
      case 0x3f: case 0x40: r.u32(); break
      case 0x41: case 0x42: r.skipLeb(); break
      case 0x43: r.skip(4); break
      case 0x44: r.skip(8); break
      case 0xd0: r.skipLeb(); break
      case 0xfc: {
        const sub = r.u32()
        if (sub <= 7) break
        if (sub === 8 || sub === 10 || sub === 12 || sub === 14) { r.u32(); r.u32() } else if (sub <= 17) r.u32()
        else throw new Error(`unknown instruction 0xfc ${sub}`)
        break
      }
      case 0xfd: {
        const sub = r.u32()
        if (sub <= 0x0b || sub === 0x5c || sub === 0x5d) skipMemarg(r)
        else if (sub === 0x0c || sub === 0x0d) r.skip(16)
        else if (sub >= 0x15 && sub <= 0x22) r.skip(1)
        else if (sub >= 0x54 && sub <= 0x5b) { skipMemarg(r); r.skip(1) }
        break
      }
      case 0xfe: {
        const sub = r.u32()
        if (sub === 0x03) r.skip(1)
        else if (sub <= 0x02 || (sub >= 0x10 && sub <= 0x4e)) skipMemarg(r)
        else throw new Error(`unknown instruction 0xfe ${sub}`)
        break
      }
      default:
        if (op >= 0x28 && op <= 0x3e) skipMemarg(r)
        else if (!(op >= 0x45 && op <= 0xc4)) throw new Error(`unknown instruction 0x${op.toString(16)} at ${r.at - 1}`)
    }
  }
  flush()
}

// --- the module ---

const program = process.argv[2]
if (!program) {
  console.error('usage: signal-checks.mjs <program.wasm>')
  process.exit(2)
}
const bytes = readFileSync(program)
// what a configure script links to see whether it can, say, is still a program; anything else is left alone
if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100) process.exit(0)

const sections = []
for (const r = new Reader(bytes, 8); r.at < bytes.length;) {
  const id = r.byte(), size = r.u32()
  sections.push({ id, body: bytes.subarray(r.at, r.at + size) })
  r.skip(size)
}
const section = id => sections.find(s => s.id === id)
const customName = s => new Reader(s.body).name()
// an object file (a relocatable link, -r) is not a program yet: its link checks it
if (sections.some(s => s.id === 0 && customName(s) === 'linking')) process.exit(0)

// the types: a `() -> ()` to give the import and the check, added if the program has none
const types = []
{
  const r = new Reader(section(1).body)
  for (let n = r.u32(); n--;) {
    const start = r.at
    if (r.byte() !== 0x60) throw new Error(`${program}: a type other than a function's`)
    const params = r.u32(); for (let i = params; i--;) skipValType(r)
    const results = r.u32(); for (let i = results; i--;) skipValType(r)
    types.push([...r.bytes.subarray(start, r.at)])
  }
}
let voidType = types.findIndex(type => type.length === 3 && type[1] === 0 && type[2] === 0)
if (voidType < 0) { voidType = types.length; types.push([0x60, 0, 0]) }

// the imports: how many functions and globals, and whether this was done already
const imports = []
let importedFunctions = 0, importedGlobals = 0
{
  const r = new Reader(section(2)?.body ?? new Uint8Array([0]))
  for (let n = r.u32(); n--;) {
    const start = r.at
    const module = r.name(), field = r.name(), kind = r.byte()
    if (module === POLL_MODULE && field === POLL_NAME) process.exit(0)
    if (kind === 0) { r.u32(); importedFunctions++ }
    else if (kind === 1) { skipValType(r); const flags = r.u32(); r.u32(); if (flags & 1) r.u32() }
    else if (kind === 2) { const flags = r.u32(); r.u32(); if (flags & 1) r.u32() }
    else if (kind === 3) { skipValType(r); r.byte(); importedGlobals++ }
    else if (kind === 4) { r.byte(); r.u32() }
    imports.push([...r.bytes.subarray(start, r.at)])
  }
}
if (importedGlobals) throw new Error(`${program}: imports a global, so global 0 is not the stack pointer`)
const poll = importedFunctions
imports.push([...name(POLL_MODULE), ...name(POLL_NAME), 0, ...u32(voidType)])
const fn = index => index < importedFunctions ? index : index + 1

// the functions it defines: the check goes after them
const functions = []
{
  const r = new Reader(section(3).body)
  for (let n = r.u32(); n--;) functions.push(r.u32())
}
const check = importedFunctions + 1 + functions.length
functions.push(voidType)

const globals = []
{
  const r = new Reader(section(6).body)
  for (let n = r.u32(); n--;) {
    const type = [...r.bytes.subarray(r.at, r.at + 2)]
    r.skip(2)
    const init = []
    copyExpression(r, init, fn)
    globals.push([...type, ...init])
  }
}
if (globals[0]?.[0] !== 0x7f || globals[0][1] !== 1) throw new Error(`${program}: global 0 is not a mutable i32, so not the stack pointer`)
const stackTop = new Reader(Uint8Array.from(globals[0]), 3)
if (globals[0][2] !== 0x41 || stackTop.s32() !== STACK_SIZE) throw new Error(`${program}: the stack does not come first in memory, so address ${WORD} is not free`)
const word = globals.length
globals.push([0x7f, 0, 0x41, ...s32(WORD), 0x0b])

// each loop reads the word and calls the check when it is set. The load is a plain one: an atomic one costs a tight
// loop a third of its speed, and engines do not take a load of shared memory out of a loop (a C program's volatile
// spin is the same load). The `if` is hinted as rarely taken (the branch hints section), or the call in the loop
// costs bzip2 half its speed again.
const head = [0x41, ...s32(WORD), 0x28, 2, 0]
const atLoop = [...head, 0x04, 0x40, 0x10, ...u32(check), 0x0b]
// the check: the import, called below the red zone
const checkBody = [0, // no locals
  0x23, 0, 0x41, ...s32(RED_ZONE), 0x6b, 0x24, 0,
  0x10, ...u32(poll),
  0x23, 0, 0x41, ...s32(RED_ZONE), 0x6a, 0x24, 0,
  0x0b]

let loops = 0
const bodies = []
/** Per function that has a loop, its index and where in its body each check's `if` is */
const hints = []
{
  const r = new Reader(section(10).body)
  for (let n = r.u32(); n--;) {
    const size = r.u32(), end = r.at + size
    // the locals, as they are
    const out = []
    const start = r.at
    for (let groups = r.u32(); groups--;) { r.u32(); skipValType(r) }
    out.push(...r.bytes.subarray(start, r.at))
    const branches = []
    copyExpression(r, out, fn, () => {
      loops++
      // a hint's offset counts from the start of the body, its locals included
      branches.push(out.length + head.length)
      return atLoop
    })
    if (r.at !== end) throw new Error(`${program}: a function body ends at ${r.at}, not ${end}`)
    if (branches.length) hints.push([...u32(fn(importedFunctions + bodies.length)), ...vector(branches.map(at => [...u32(at), 1, 0]))])
    bodies.push([...u32(out.length), ...out])
  }
  bodies.push([...u32(checkBody.length), ...checkBody])
}

/** The exports, renumbered, and for the host the word's global and the stack pointer (a handler's alternate stack) */
function exportsRenumbered(body) {
  const r = new Reader(body), out = []
  const n = r.u32()
  out.push(...u32(n + 2))
  for (let i = n; i--;) {
    const field = r.name(), kind = r.byte(), index = r.u32()
    out.push(...name(field), kind, ...u32(kind === 0 ? fn(index) : index))
  }
  out.push(...name(WORD_EXPORT), 3, ...u32(word))
  out.push(...name(STACK_POINTER_EXPORT), 3, 0)
  return out
}

function elementsRenumbered(body) {
  const r = new Reader(body), out = []
  const n = r.u32()
  out.push(...u32(n))
  for (let i = n; i--;) {
    const flags = r.u32()
    out.push(...u32(flags))
    if (flags & 2 && !(flags & 1)) out.push(...u32(r.u32())) // a table index
    if (!(flags & 1)) copyExpression(r, out, fn) // the offset
    const expressions = flags & 4
    if (flags & 3) { // an element kind, or a reference type
      const at = r.at; expressions ? skipValType(r) : r.byte(); out.push(...r.bytes.subarray(at, r.at))
    }
    const count = r.u32()
    out.push(...u32(count))
    for (let j = count; j--;) expressions ? copyExpression(r, out, fn) : out.push(...u32(fn(r.u32())))
  }
  return out
}

/**
 * The name section, renumbered: the function, local and label names are by function index (Binaryen finds the stack
 * pointer by its name, for one), and the import and the check get theirs
 */
function namesRenumbered(body) {
  const r = new Reader(body), out = [...name('name')]
  r.name()
  while (r.at < body.length) {
    const id = r.byte(), size = r.u32(), end = r.at + size
    let content
    if (id === 1) {
      const entries = []
      for (let n = r.u32(); n--;) {
        const index = fn(r.u32())
        entries.push([index, r.name()])
      }
      entries.push([poll, POLL_NAME], [check, '__ecmaos_signal_check'])
      entries.sort((a, b) => a[0] - b[0])
      content = vector(entries.map(([index, text]) => [...u32(index), ...name(text)]))
    } else if (id === 2 || id === 3) {
      // per function, its locals' or labels' names, which stay as they are
      const count = r.u32()
      content = [...u32(count)]
      for (let n = count; n--;) {
        const index = r.u32(), at = r.at
        for (let m = r.u32(); m--;) { r.u32(); r.name() }
        content.push(...u32(fn(index)), ...r.bytes.subarray(at, r.at))
      }
    } else content = [...r.bytes.subarray(r.at, end)]
    r.at = end
    out.push(id, ...u32(content.length))
    for (const byte of content) out.push(byte)
  }
  return out
}

const rebuilt = {
  1: vector(types),
  2: vector(imports),
  3: [...u32(functions.length), ...functions.flatMap(type => u32(type))],
  6: vector(globals),
  7: exportsRenumbered(section(7).body),
  8: section(8) && u32(fn(new Reader(section(8).body).u32())),
  9: section(9) && elementsRenumbered(section(9).body),
  10: vector(bodies)
}

const parts = [bytes.subarray(0, 8)]
for (const s of sections) {
  if (s.id === 0 && (customName(s).startsWith('.debug') || customName(s) === 'metadata.code.branch_hint')) continue
  // the hints go before the code they are about
  if (s.id === 10) {
    const hinted = [...name('metadata.code.branch_hint'), ...vector(hints)]
    parts.push(new Uint8Array([0, ...u32(hinted.length)]), Uint8Array.from(hinted))
  }
  const body = s.id === 0 && customName(s) === 'name' ? namesRenumbered(s.body) : rebuilt[s.id] ?? s.body
  parts.push(new Uint8Array([s.id, ...u32(body.length)]), Uint8Array.from(body))
}
const result = new Uint8Array(Buffer.concat(parts))
if (!WebAssembly.validate(result)) throw new Error(`${program}: the rewritten module does not validate`)
writeFileSync(program, result)
if (process.env.SIGNAL_CHECKS_VERBOSE) console.error(`signal-checks: ${program}: ${loops} loops`)
