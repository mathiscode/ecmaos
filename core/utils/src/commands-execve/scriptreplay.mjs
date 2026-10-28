/**
 * `scriptreplay`: play back what `script` recorded, at the speed it was written, as util-linux's scriptreplay does:
 * a typescript with its timing file, in the classic format or the advanced one (`-x` picks the stream). An asciicast
 * (asciinema's `.cast`, version 2 or 3, which `script --cast` writes) plays by itself, named alone or with `--cast`.
 */

import { reasonOf } from './lib/errno.mjs'
import { readTextFile } from './lib/fs-text.mjs'
import { getopt, tryHelp } from './lib/getopt.mjs'

const { argv, exit, open, read, close, writeAll, O_RDONLY } = globalThis.ecmaosSyscalls
const encoder = new TextEncoder()
const err = text => writeAll(2, encoder.encode(`scriptreplay: ${text}\n`))

const usage = `Usage:
 scriptreplay [options]
 scriptreplay [-t] timingfile [typescript] [divisor]
 scriptreplay [--cast] file.cast [divisor]

Play back terminal typescripts, using timing information.

Options:
 -I, --log-in <file>           script stdin log file
 -O, --log-out <file>          script stdout log file (default)
 -B, --log-io <file>           script stdin and stdout log file
 -t, --timing <file>           script timing log file
 -T, --log-timing <file>       alias to -t
 -s, --typescript <file>       deprecated alias to -O
     --cast <file>             an asciicast (asciinema's .cast, version 2 or 3)
 -x, --stream <name>           stream type (out or in)
 -c, --cr-mode <type>          CR char mode (auto, never, always)
 -d, --divisor <num>           speed up or slow down execution with time divisor
 -m, --maxdelay <num>          wait at most this many seconds between updates
 -h, --help                    display this help
 -V, --version                 display version`

const sleep = seconds => seconds > 0 ? new Promise(resolve => setTimeout(resolve, seconds * 1000)) : undefined

/** The whole file as bytes */
function readBytes(path) {
  const fd = open(path, O_RDONLY)
  const chunks = []
  let total = 0
  try {
    const buffer = new Uint8Array(65536)
    for (;;) {
      const n = read(fd, buffer, -1)
      if (n <= 0) break
      chunks.push(buffer.slice(0, n))
      total += n
    }
  } finally { close(fd) }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
  return bytes
}

/** Whether a file's first line is an asciicast header */
function isCast(path) {
  try {
    const first = readTextFile(path).split('\n', 1)[0]
    const header = JSON.parse(first)
    return typeof header === 'object' && header !== null && (header.version === 2 || header.version === 3)
  } catch { return false }
}

/** `[{ delay, data }]` of an asciicast's output, each delay in seconds since the one before */
function castEvents(path, stream) {
  const lines = readTextFile(path).split('\n').filter(line => line.trim())
  const header = JSON.parse(lines[0])
  const code = stream === 'in' ? 'i' : 'o'
  const events = []
  let previous = 0
  let pending = 0
  for (const line of lines.slice(1)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (!Array.isArray(event)) continue
    const [time, kind, data] = event
    // version 2 gives each event's time since the start; version 3 the time since the event before
    const delay = header.version === 3 ? time : time - previous
    previous = header.version === 3 ? previous + time : time
    pending += delay
    if (kind !== code) continue
    events.push({ delay: pending, data: encoder.encode(String(data)) })
    pending = 0
  }
  return events
}

/**
 * `[{ delay, data }]` of a typescript, cut by its timing file into the writes `script` saw; `shared` when the input
 * and the output are logged in the one file (`script -B`)
 */
function scriptEvents(typescript, timingPath, stream, shared) {
  const bytes = readBytes(typescript)
  // the first line is script's own (`Script started on ...`), not the session's
  let at = bytes.indexOf(10) + 1
  const want = stream === 'in' ? 'I' : 'O'
  const events = []
  let pending = 0
  for (const line of readTextFile(timingPath).split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (!fields[0]) continue
    let kind = 'O', delay, length
    if (/^[A-Z]$/.test(fields[0])) [kind, delay, length] = [fields[0], Number(fields[1]), Number(fields[2])]
    else [delay, length] = [Number(fields[0]), Number(fields[1])]
    if (!Number.isFinite(delay)) throw new Error(`${timingPath}: unexpected timing line: ${line}`)
    pending += delay
    // signals and information lines (S, H) carry no bytes of the log; the other stream's do when both are in one (-B)
    if (kind !== want) { if (shared && (kind === 'I' || kind === 'O')) at += length; continue }
    events.push({ delay: pending, data: bytes.subarray(at, at + length) })
    at += length
    pending = 0
  }
  return events
}

async function main() {
  const { options, operands, error } = getopt(argv.slice(1), {
    short: 'I:O:B:t:T:s:x:c:d:m:hV',
    long: {
      'log-in': { key: 'I', arg: 'required' }, 'log-out': { key: 'O', arg: 'required' }, 'log-io': { key: 'B', arg: 'required' },
      timing: { key: 't', arg: 'required' }, 'log-timing': { key: 't', arg: 'required' }, typescript: { key: 'O', arg: 'required' },
      cast: { key: 'cast', arg: 'required' }, stream: { key: 'x', arg: 'required' }, 'cr-mode': { key: 'c', arg: 'required' },
      divisor: { key: 'd', arg: 'required' }, maxdelay: { key: 'm', arg: 'required' }, help: 'h', version: 'V'
    }
  })
  if (error) { err(error); writeAll(2, encoder.encode(tryHelp('scriptreplay') + '\n')); return 1 }
  let inLog, outLog, timing, cast, stream, divisor = 1, maxDelay
  for (const [key, value] of options) {
    if (key === 'h') { writeAll(1, encoder.encode(usage + '\n')); return 0 }
    if (key === 'V') { writeAll(1, encoder.encode('scriptreplay from util-linux 2.41 (ecmaOS)\n')); return 0 }
    if (key === 'I') inLog = value
    else if (key === 'O' || key === 's') outLog = value
    else if (key === 'B') inLog = outLog = value
    else if (key === 't' || key === 'T') timing = value
    else if (key === 'cast') cast = value
    else if (key === 'x') {
      if (value !== 'out' && value !== 'in') { err(`unsupported stream name: '${value}'`); return 1 }
      stream = value
    } else if (key === 'd' || key === 'm') {
      const number = Number(value)
      if (!(number > 0)) { err(`${key === 'd' ? 'divisor' : 'maximum delay'} must be a positive number: '${value}'`); return 1 }
      if (key === 'd') divisor = number
      else maxDelay = number
    }
  }
  const rest = [...operands]
  // `scriptreplay file.cast [divisor]`, or the classic `scriptreplay timing [typescript [divisor]]`
  if (!cast && !timing && rest[0] && isCast(rest[0])) cast = rest.shift()
  if (!cast) {
    if (!timing && rest.length) timing = rest.shift()
    if (!outLog && !inLog && rest.length) outLog = rest.shift()
  }
  if (rest.length) {
    divisor = Number(rest.shift())
    if (!(divisor > 0)) { err('divisor must be a positive number'); return 1 }
  }
  if (rest.length) { err('unexpected number of arguments'); return 1 }
  stream ??= inLog && !outLog ? 'in' : 'out'

  let events
  try {
    if (cast) events = castEvents(cast, stream)
    else {
      if (!timing) { err('timing file not specified'); writeAll(2, encoder.encode(tryHelp('scriptreplay') + '\n')); return 1 }
      events = scriptEvents((stream === 'in' ? inLog : outLog) ?? 'typescript', timing, stream, inLog !== undefined && inLog === outLog)
    }
  } catch (e) { err(e.code ? `${e.path ?? cast ?? timing}: ${reasonOf(e)}` : e.message); return 1 }

  for (const { delay, data } of events) {
    const wait = delay / divisor
    await sleep(maxDelay !== undefined ? Math.min(wait, maxDelay) : wait)
    writeAll(1, data)
  }
  return 0
}

exit(await main())
