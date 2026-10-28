/** `tsort`: write the items of a partial order (pairs `A B`, A before B) in an order that keeps it, as GNU tsort does. */

import { reasonOf } from './lib/errno.mjs'
import { readFdText, readTextFile } from './lib/fs-text.mjs'

const { argv, exit, writeAll } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`tsort: ${text}\n`))

const usage = `Usage: tsort [OPTION] [FILE]
Write totally ordered list consistent with the partial ordering in FILE.

With no FILE, or when FILE is -, read standard input.

      --help        display this help and exit
      --version     output version information and exit`

function main() {
  const args = argv.slice(1)
  if (args[0] === '--help') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
  if (args[0] === '--version') { writeAll(1, encoder.encode('tsort (ecmaOS coreutils) 1.0\n')); return 0 }
  const files = args.filter(arg => arg !== '--')
  if (files.length > 1) { err(`extra operand '${files[1]}'`); return 1 }
  const file = files[0] ?? '-'
  let text
  try { text = file === '-' ? readFdText(0) : readTextFile(file) } catch (e) { err(`${file}: ${reasonOf(e)}`); return 1 }
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length % 2) { err(`${file}: input contains an odd number of tokens`); return 1 }
  const successors = new Map()
  const indegree = new Map()
  const add = word => { if (!successors.has(word)) { successors.set(word, []); indegree.set(word, 0) } }
  for (let i = 0; i < words.length; i += 2) {
    const [a, b] = [words[i], words[i + 1]]
    add(a); add(b)
    if (a !== b) { successors.get(a).push(b); indegree.set(b, indegree.get(b) + 1) }
  }
  const order = []
  let status = 0
  const queue = [...successors.keys()].filter(word => indegree.get(word) === 0)
  while (order.length < successors.size) {
    if (queue.length === 0) {
      // a loop: say so, name its members, and break it at the first item still waiting, as GNU does
      const rest = [...successors.keys()].filter(word => indegree.get(word) > 0)
      err(`${file}: input contains a loop:`)
      const start = rest[0]
      const loop = [start]
      for (let next = successors.get(start).find(word => indegree.get(word) > 0); next && !loop.includes(next); next = successors.get(next).find(word => indegree.get(word) > 0)) loop.push(next)
      for (const word of loop) err(word)
      status = 1
      indegree.set(start, 0)
      queue.push(start)
    }
    const word = queue.shift()
    if (indegree.get(word) === -1) continue
    indegree.set(word, -1)
    order.push(word)
    for (const next of successors.get(word)) {
      if (indegree.get(next) <= 0) continue
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  writeAll(1, encoder.encode(order.map(word => word + '\n').join('')))
  return status
}

try {
  exit(main())
} catch (error) {
  err(reasonOf(error))
  exit(1)
}
